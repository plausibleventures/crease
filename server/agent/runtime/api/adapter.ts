// Direct API runtime (R11f, runtime "api"): an app-owned tool-calling loop for when no agent program (Claude Code,
// Codex, Grok) is installed. The app talks to a model endpoint itself (endpoint.ts: Anthropic Messages API, or an
// OpenAI-compatible Chat Completions server) and owns everything a harness would: the conversation (conversation.ts,
// persisted per session, rebuilt on resume/fork), the tools (structured file tools + skills + the app's registry tools
// + AskUserQuestion; no shell), retries, limits, context trimming, cancellation and usage.
//
// One turn: append the user's message -> loop { trim if the context is large -> stream one model response (retried
// with backoff on 429/5xx/overloaded, also when it breaks mid-stream) -> run its tool calls (registry: app identity
// and gates; file tools: policy.ts) -> append the results } until the model answers without tools, the user stops it,
// the step limit is hit, or a budget stop interrupts it (the coordinator watches usage.updated).
import { randomUUID } from "node:crypto"
import { getSettings } from "../../../config"
import { getMachines } from "../../../machines"
import type {
  AgentConnectionResult,
  AgentConnectionStep,
  AgentEffort,
  AgentModelList,
  AgentProfileSnapshot,
  AgentRuntimeCapabilities,
  AgentRuntimeProbe,
  AgentTokenUsage,
  AgentUsage,
  ApiProtocol,
} from "../../../../shared/types"
import { getSecret, ANTHROPIC_API_KEY_REF } from "../../../secrets"
import { answerQuestion as answerPendingQuestion } from "../../questions"
import type { ToolResult } from "../../registry"
import type { AdapterHost, AgentAdapter, AgentRuntime, AgentSessionContext, AgentTurnInput, QuestionInput } from "../types"
import { AnthropicEndpoint, ANTHROPIC_DEFAULT_URL } from "./anthropic"
import { apiSessionPath, ConversationStore, estimateTokens, stripThinking, trimHistory, unansweredToolResults, type ConvBlock, type ConvMessage } from "./conversation"
import { ENDPOINTS, EndpointError, noSink, type Endpoint, type ModelRequest, type ModelResponse, type StreamSink, type Usage } from "./endpoint"
import { apiInstructions } from "./instructions"
import { OpenAiChatEndpoint } from "./openai"
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_SUGGESTED_MODELS, responseCostUsd } from "./pricing"
import { askInput, ASK_TOOL, FILE_TOOLS, runFileTool, timelineCall, toolSpecs, type FileToolContext } from "./tools"

/* eslint-disable @typescript-eslint/no-explicit-any */

export const API_AUTH_CODE = "api.auth"
export const API_NO_KEY = "No API key saved. Add one in Designers."
export const API_NO_ENDPOINT = "No server address. Set it in Designers (e.g. http://localhost:11434/v1)."
export const API_NO_MODEL = "Pick a model in Designers."
export const API_PRINTER_ENDPOINT = "The endpoint address points at one of your printers. Crease never sends design chats to a printer."
export const API_EFFORTS: AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]

/** Model steps (requests) one user turn may take before it's stopped. */
export const DEFAULT_MAX_STEPS = 80
const MAX_ATTEMPTS = 6
const MAX_CONTINUATIONS = 2

export function apiCapabilities(): AgentRuntimeCapabilities {
  return {
    images: true, // Anthropic: yes; OpenAI-compatible: depends on the server's model (untested label on the card)
    streaming: true,
    appTools: true,
    userQuestions: true,
    permissionRequests: false, // nothing to ask about: no shell, writes are decided by policy
    resume: true, // rebuilt from the app's own conversation store
    fork: true,
    modelSwitch: true,
    usage: "reported", // provider-reported tokens; USD from published prices on the Anthropic API only
    // No shell and no network tools: the model can only use the app's tools, which keep to the project folder.
    isolation: { workspaceWrites: true, network: true, level: "full" },
  }
}

/** What the runtime needs from the outside world; tests replace it (scripted servers, no sleeping). */
export interface ApiDeps {
  secret(ref: string): string | null
  endpoint(o: { protocol: ApiProtocol; baseUrl: string; apiKey: string | null }): Endpoint
  /** Published prices apply to this endpoint (the first-party Anthropic API only). */
  priced(e: Endpoint): boolean
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** Hosts the endpoint may never be (printers). */
  printerHosts(): string[]
  /** Trim the conversation when a request's prompt passes this many tokens. */
  trimAt?: number
  maxTokens?: number
  skillsDir?: string
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res) => {
    if (signal.aborted) return res()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener("abort", done)
      res()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

function printerHostsNow(): string[] {
  const hosts: string[] = []
  try {
    const h = getSettings().printer?.host
    if (h) hosts.push(h)
  } catch {
    /* none */
  }
  try {
    for (const m of getMachines()) if (m.connection.type === "moonraker" && m.connection.host) hosts.push(m.connection.host)
  } catch {
    /* none */
  }
  return hosts
}

export const defaultApiDeps: ApiDeps = {
  secret: (ref) => getSecret(ref) ?? (ref === ANTHROPIC_API_KEY_REF ? process.env.ANTHROPIC_API_KEY || null : null),
  endpoint: (o) => (o.protocol === "anthropic" ? new AnthropicEndpoint({ apiKey: o.apiKey ?? "", baseUrl: o.baseUrl }) : new OpenAiChatEndpoint({ baseUrl: o.baseUrl, apiKey: o.apiKey })),
  priced: (e) => e.protocol === "anthropic" && e.baseUrl === ANTHROPIC_DEFAULT_URL,
  sleep,
  printerHosts: printerHostsNow,
}

export const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|[\w-]+\.local)(:\d+)?(\/|$)/i.test(u)

export interface ApiAccess {
  protocol: ApiProtocol
  baseUrl: string
  apiKey: string | null
  model: string | null
  endpoint: Endpoint
}

/** Protocol, endpoint, key and model of a profile. Throws plain-words errors (statusCode 409). */
export function apiAccess(deps: ApiDeps, profile: AgentProfileSnapshot, opts: { needModel?: boolean } = {}): ApiAccess {
  const fail = (m: string) => Object.assign(new Error(m), { statusCode: 409 })
  const protocol: ApiProtocol = profile.apiProtocol ?? "anthropic"
  const baseUrl = (profile.endpointRef || ENDPOINTS[protocol].defaultUrl || "").replace(/\/+$/, "")
  if (!baseUrl) throw fail(API_NO_ENDPOINT)
  let host = ""
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    throw fail(API_NO_ENDPOINT)
  }
  if (deps.printerHosts().some((h) => h.toLowerCase() === host)) throw fail(API_PRINTER_ENDPOINT)
  const apiKey = profile.auth.kind === "api-key" ? deps.secret(profile.auth.credentialRef) : null
  if (!apiKey && !(protocol === "openai-chat" && isLocalUrl(baseUrl))) throw fail(API_NO_KEY)
  const model = profile.model || (protocol === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : null)
  if (!model && opts.needModel) throw fail(API_NO_MODEL)
  return { protocol, baseUrl, apiKey, model, endpoint: deps.endpoint({ protocol, baseUrl, apiKey }) }
}

/** Copy of a provider message for the native log (images and long strings shortened). */
function forLog(m: unknown): unknown {
  return JSON.parse(JSON.stringify(m ?? null, (k, v) => (typeof v === "string" && v.length > 2000 ? `${v.slice(0, 200)}… [${v.length} chars]` : k === "data" && typeof v === "string" && v.length > 200 ? "[image]" : v)))
}

const addUsage = (a: AgentTokenUsage, u: Usage): AgentTokenUsage => {
  const add = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0))
  return { input: add(a.input, u.input), output: add(a.output, u.output), cacheRead: add(a.cacheRead, u.cacheRead), cacheWrite: add(a.cacheWrite, u.cacheWrite) }
}

const textOf = (r: ToolResult) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n")

type Outcome = { kind: "completed"; text: string } | { kind: "interrupted" } | { kind: "failed"; error: string; auth?: boolean } | { kind: "max_steps"; steps: number } | { kind: "refusal" }

const ABORTED = Symbol("aborted")

export class ApiAdapter implements AgentAdapter {
  private ctx!: AgentSessionContext
  private access!: ApiAccess
  private store!: ConversationStore
  private system = ""
  private tools: ReturnType<typeof toolSpecs> = []
  private model = ""
  private running = false
  private queue: AgentTurnInput[] = []
  private turnAbort = new AbortController()
  private turnN = 0
  private interrupting = false
  private closed = false
  private _alive = false
  private costBase = 0
  private spent = 0
  private unpriced = false
  private lastPromptTokens: number | null = null
  private fileCtx!: FileToolContext

  constructor(
    private host: AdapterHost,
    private deps: ApiDeps = defaultApiDeps
  ) {}

  get alive() {
    return this._alive
  }

  async start(ctx: AgentSessionContext): Promise<{ nativeSessionId: string | null }> {
    this.ctx = ctx
    this.access = apiAccess(this.deps, ctx.profile, { needModel: true })
    this.model = this.access.model!
    this.costBase = ctx.priorCostUsd
    // Frozen for the session: the system prompt and the tool list are the cached (and thinking-bound) prefix.
    this.system = apiInstructions(ctx.instructions)
    this.tools = toolSpecs(ctx.tools.list())
    this.fileCtx = {
      root: ctx.cwd,
      denyRead: ctx.policy.denyRead ?? [],
      onWrite: (tool, abs) => this.host.nativeToolAllowed(tool, { file_path: abs }),
      skillsDir: this.deps.skillsDir,
    }
    const id = ctx.resume ?? ctx.sessionId
    this.store = new ConversationStore(apiSessionPath(ctx.cwd, id))
    if (ctx.resume && !this.store.exists)
      this.host.emit({ type: "notice", level: "info", text: "Couldn't find the earlier conversation for this designer; starting a fresh one in this session. Your design files are all here." }, { itemId: `resume:${id}:${Date.now()}` })
    const loaded = this.store.load()
    if (loaded.length) {
      // The prefix changed (a new brief, maybe new tools): earlier thinking is bound to the old one. Drop it once.
      const s = stripThinking(loaded)
      if (s.changed || loaded.some((m) => m.native)) this.store.replace(s.messages, "resume")
      const fix = unansweredToolResults(this.store.messages, "Not run: the earlier request was stopped.")
      if (fix) this.store.append(fix)
    }
    this._alive = true
    this.host.emit(
      {
        type: "notice",
        level: "info",
        text: `Session started (API connection: ${ENDPOINTS[this.access.protocol].label})`,
        code: "session.started",
        data: { cwd: ctx.cwd, model: this.model, runtime: "api", protocol: this.access.protocol, endpoint: this.access.baseUrl, resumedMessages: loaded.length },
      },
      { itemId: `start:${id}:${Date.now()}` }
    )
    return { nativeSessionId: id }
  }

  /** While a turn runs, a message waits for the next step boundary (after the tool results) and joins the turn there. */
  send(input: AgentTurnInput) {
    if (this.running) this.queue.push(input)
    else void this.runTurn([input])
  }

  answerQuestion(requestId: string, answers: Record<string, string>, notes?: Record<string, string>) {
    answerPendingQuestion(this.ctx.projectId, requestId, answers, notes)
  }

  answerPermission(): void {
    throw new Error("The API connection doesn't ask for permissions.")
  }

  async interrupt() {
    if (!this._alive) return
    this.queue.length = 0
    if (!this.running) return
    this.interrupting = true
    this.turnAbort.abort(ABORTED)
  }

  async setModel(model: string) {
    if (!model || model === this.model) return
    this.model = model
    // Thinking is bound to the model that wrote it: start the new model without it.
    const s = stripThinking(this.store.messages)
    if (s.changed) this.store.replace(s.messages, "model switch")
  }

  close() {
    if (this.closed) return
    this.closed = true
    this._alive = false
    this.queue.length = 0
    this.turnAbort.abort(ABORTED)
  }

  // ---------------------------------------------------------------------------------------------
  // The loop
  // ---------------------------------------------------------------------------------------------

  private cost(): number | null {
    return this.unpriced || !this.deps.priced(this.access.endpoint) ? null : this.costBase + this.spent
  }

  private usage(tokens: AgentTokenUsage, final: boolean): AgentUsage {
    const c = this.cost()
    return { tokens, billedUsd: c, estimatedApiUsd: c, billing: "api", subscription: null, final }
  }

  private async runTurn(ts: AgentTurnInput[]) {
    this.running = true
    this.interrupting = false
    this.turnAbort = new AbortController()
    const signal = this.turnAbort.signal
    const turn = `t${++this.turnN}-${Date.now().toString(36)}`
    const startedAt = Date.now()
    let tokens: AgentTokenUsage = { input: null, output: null, cacheRead: null, cacheWrite: null }
    let steps = 0
    let outcome: Outcome
    try {
      const fix = unansweredToolResults(this.store.messages)
      if (fix) this.store.append(fix)
      this.store.append({ role: "user", content: ts.flatMap((t) => userBlocks(t)) })
      for (const t of ts) if (t.id) this.host.received?.(t.id)
      let lastText = ""
      let continuations = 0
      const maxSteps = this.ctx.maxTurns ?? DEFAULT_MAX_STEPS
      for (;;) {
        if (signal.aborted) throw ABORTED
        if (steps >= maxSteps) {
          outcome = { kind: "max_steps", steps }
          break
        }
        this.maybeTrim(turn)
        steps++
        const r = await this.request(turn, steps, signal)
        tokens = addUsage(tokens, r.usage)
        this.lastPromptTokens = (r.usage.input ?? 0) + (r.usage.cacheRead ?? 0) + (r.usage.cacheWrite ?? 0) + (r.usage.output ?? 0) || null
        const c = this.deps.priced(this.access.endpoint) ? responseCostUsd(r.model || this.model, r.usage) : null
        if (c === null) this.unpriced = true
        else this.spent += c
        this.host.native({ type: "api_response", step: steps, id: r.id, model: r.model, stop: r.rawStop, usage: r.usage, content: forLog(r.message.native?.content ?? r.message.content) })
        this.store.append(r.message)
        const calls = r.message.content.filter((b): b is Extract<ConvBlock, { type: "tool_use" }> => b.type === "tool_use")
        for (const call of calls) {
          const tc = timelineCall(call.name, call.input)
          this.host.emit({ type: "tool.started", name: tc.name, input: tc.input, stepId: `${turn}:r${steps}` }, { itemId: `${turn}:${call.id}` })
        }
        const text = r.message.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n\n")
          .trim()
        if (text) lastText = text
        this.host.emit({ type: "usage.updated", usage: this.usage(tokens, false) }, { persist: false })
        if (r.stop === "refusal") {
          // A refusal can cut a tool call off mid-input: none of this turn's calls run.
          if (calls.length) this.store.append(this.answerAll(turn, calls, "Not run: the model declined this request."))
          outcome = { kind: "refusal" }
          break
        }
        if (!calls.length) {
          if (r.stop === "max_tokens" && continuations < MAX_CONTINUATIONS) {
            continuations++
            this.store.append({ role: "user", content: [{ type: "text", text: "(Your reply was cut off at the length limit. Continue from where you stopped, more briefly.)" }] })
            continue
          }
          if (r.stop === "pause_turn") continue
          if (this.queue.length) {
            // The user wrote while this reply was being written: answer that before the turn ends.
            const late = this.queue.splice(0)
            this.store.append({ role: "user", content: late.flatMap((t) => userBlocks(t, true)) })
            for (const t of late) if (t.id) this.host.received?.(t.id)
            continue
          }
          outcome = { kind: "completed", text: lastText }
          break
        }
        if (r.stop === "max_tokens") {
          // The last call's input was cut off (it can still parse): run none of them, tell the model why.
          this.store.append(
            this.answerAll(turn, calls, "Not run: your reply hit the output length limit while writing this call, so its input is incomplete. Make it smaller (e.g. split a long file into parts or use edit_file) and try again.")
          )
          continue
        }
        const results = await this.runTools(turn, calls, r.badJson, signal)
        if (signal.aborted) {
          this.store.append({ role: "user", content: results })
          throw ABORTED
        }
        // Messages the user sent meanwhile join the turn here, so the next step already plans around them.
        const late = this.queue.splice(0)
        this.store.append({ role: "user", content: [...results, ...late.flatMap((t) => userBlocks(t, true))] })
        for (const t of late) if (t.id) this.host.received?.(t.id)
      }
    } catch (e) {
      if (e === ABORTED || signal.aborted) outcome = { kind: "interrupted" }
      else if (e instanceof EndpointError) outcome = { kind: "failed", error: this.explain(e), auth: e.kind === "auth" }
      else outcome = { kind: "failed", error: e instanceof Error ? e.message : String(e) }
    }
    this.finish(turn, outcome, tokens, steps, startedAt)
  }

  private explain(e: EndpointError): string {
    const where = ENDPOINTS[this.access.protocol].label
    switch (e.kind) {
      case "auth":
        return `${where} refused the API key (${e.message}). Replace the key in Designers.`
      case "not_found":
        return `${where} doesn't know the model "${this.model}" (${e.message}). Pick another model in Designers.`
      case "rate_limit":
      case "overloaded":
      case "server":
      case "connection":
      case "bad_stream":
        return `${where} kept failing after several tries (${e.message}). Try again in a minute.`
      default:
        return `${where} returned an error: ${e.message}`
    }
  }

  /** Answer every call of a turn without running it (refusal, truncated output, stop). */
  private answerAll(turn: string, calls: Extract<ConvBlock, { type: "tool_use" }>[], text: string): ConvMessage {
    for (const c of calls) this.host.emit({ type: "tool.completed", isError: true, text, images: [] }, { itemId: `${turn}:${c.id}` })
    return { role: "user", content: calls.map((c) => ({ type: "tool_result" as const, toolUseId: c.id, isError: true, content: [{ type: "text" as const, text }] })) }
  }

  /** Context trimming before a request (large history only; see conversation.ts trimHistory). */
  private maybeTrim(turn: string) {
    const limit = this.deps.trimAt ?? 150_000
    const used = this.lastPromptTokens ?? estimateTokens(this.store.messages, this.system)
    if (used < limit) return
    const r = trimHistory(this.store.messages, Math.floor(limit * 0.5))
    if (!r) return
    this.store.replace(r.messages, "trim")
    this.lastPromptTokens = null
    this.host.native({ type: "api_trim", before: r.before, after: r.after })
    this.host.emit(
      { type: "notice", level: "info", text: "Made room in the conversation: older tool output and pictures were set aside. Your design files and decisions are unchanged.", code: "context.trimmed", data: { before: r.before, after: r.after } },
      { itemId: `trim:${turn}:${Date.now()}` }
    )
  }

  /** Live callbacks for one attempt. Finished text/thinking blocks wait in `done` until the response succeeds. */
  private sink(turn: string, step: number, attempt: number, done: { itemId: string; kind: "text" | "thinking"; text: string; stepId: string }[]): StreamSink {
    const base = `${turn}:r${step}${attempt > 1 ? `a${attempt}` : ""}`
    const stepId = `${turn}:r${step}`
    const toolIds = new Map<number, string>()
    return {
      text: (i, delta) => delta && this.host.emit({ type: "message.delta", role: "assistant", kind: "text", delta }, { itemId: `${base}:b${i}`, persist: false }),
      thinking: (i, delta) => delta && this.host.emit({ type: "message.delta", role: "assistant", kind: "thinking", delta }, { itemId: `${base}:b${i}`, persist: false }),
      toolStart: (i, id, name) => {
        toolIds.set(i, id)
        this.host.emit({ type: "tool.started", name: timelineCall(name, {}).name, stepId }, { itemId: `${turn}:${id}`, persist: false })
      },
      toolInput: (i, id, delta) => this.host.emit({ type: "tool.started", inputDelta: delta, stepId } as any, { itemId: `${turn}:${toolIds.get(i) ?? id}`, persist: false }),
      blockDone: (i, kind, text) => void (text.trim() && done.push({ itemId: `${base}:b${i}`, kind, text, stepId })),
    }
  }

  /** One model response, retried with backoff on transient failures (also when a stream breaks off midway). */
  private async request(turn: string, step: number, signal: AbortSignal): Promise<ModelResponse> {
    let strippedThinking = false
    let told = false
    for (let attempt = 1; ; attempt++) {
      const req: ModelRequest = { model: this.model, system: this.system, tools: this.tools, messages: this.store.messages, maxTokens: this.deps.maxTokens ?? 32_000, effort: this.ctx.profile.effort }
      try {
        const done: Parameters<ApiAdapter["sink"]>[3] = []
        const r = await this.access.endpoint.stream(req, this.sink(turn, step, attempt, done), signal)
        // Only a response that arrived whole is kept (a broken attempt's partial text was live-only).
        for (const d of done) this.host.emit({ type: "message.completed", role: "assistant", kind: d.kind, text: d.text, stepId: d.stepId }, { itemId: d.itemId })
        return r
      } catch (e) {
        if (signal.aborted) throw ABORTED
        const err = e instanceof EndpointError ? e : new EndpointError(e instanceof Error ? e.message : String(e), "other")
        this.host.native({ type: "api_error", step, attempt, kind: err.kind, status: err.status, message: err.message })
        if (err.kind === "thinking_signature" && !strippedThinking) {
          // The history no longer matches what earlier thinking was bound to: drop it once and retry.
          strippedThinking = true
          this.store.replace(stripThinking(this.store.messages).messages, "thinking signature")
          continue
        }
        if (!err.retryable || attempt >= MAX_ATTEMPTS) throw err
        const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4)
        const wait = err.retryAfter !== null ? Math.min(60_000, err.retryAfter * 1000) : backoff
        if (!told) {
          told = true
          const why = err.kind === "rate_limit" ? "is rate-limiting this key" : err.kind === "overloaded" ? "is busy" : "had a hiccup"
          this.host.emit({ type: "notice", level: "info", text: `The model service ${why}; trying again…`, code: "api.retry", data: { kind: err.kind, status: err.status } }, { itemId: `retry:${turn}:r${step}` })
        }
        await this.deps.sleep(wait, signal)
        if (signal.aborted) throw ABORTED
      }
    }
  }

  /** Run one response's tool calls in order. Results go back in one user message. */
  private async runTools(turn: string, calls: Extract<ConvBlock, { type: "tool_use" }>[], badJson: Record<string, string>, signal: AbortSignal): Promise<ConvBlock[]> {
    const out: ConvBlock[] = []
    for (const call of calls) {
      const itemId = `${turn}:${call.id}`
      let r: ToolResult
      if (signal.aborted) r = { content: [{ type: "text", text: "Not run: the user stopped this request." }], isError: true }
      else if (call.id in badJson) r = { content: [{ type: "text", text: JSON.stringify({ INVALID_JSON: badJson[call.id] }) }], isError: true }
      else {
        const p = this.runTool(turn, call)
        const stopped = new Promise<typeof ABORTED>((res) => (signal.aborted ? res(ABORTED) : signal.addEventListener("abort", () => res(ABORTED), { once: true })))
        const got = await Promise.race([p, stopped])
        r = got === ABORTED ? { content: [{ type: "text", text: "Stopped by the user before this finished." }], isError: true } : got
      }
      const images = r.content.filter((c) => c.type === "image").map((c) => ({ mediaType: (c as { mimeType: string }).mimeType, data: (c as { data: string }).data }))
      this.host.emit({ type: "tool.completed", isError: !!r.isError, text: textOf(r), images }, { itemId })
      out.push({
        type: "tool_result",
        toolUseId: call.id,
        isError: !!r.isError,
        content: r.content.map((c) => (c.type === "text" ? { type: "text" as const, text: c.text } : { type: "image" as const, mediaType: c.mimeType, data: c.data })),
      })
    }
    return out
  }

  private async runTool(turn: string, call: Extract<ConvBlock, { type: "tool_use" }>): Promise<ToolResult> {
    if (call.name === ASK_TOOL) {
      const parsed = askInput.safeParse(call.input)
      if (!parsed.success) return { content: [{ type: "text", text: `Error: Invalid input for ${ASK_TOOL}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }], isError: true }
      const o = await this.host.askUser(parsed.data as QuestionInput, { signal: this.turnAbort.signal, toolUseID: `${turn}:${call.id}` })
      if (!o.answered) return { content: [{ type: "text", text: o.message }], isError: true }
      const parts = Object.entries(o.answers).map(([q, a]) => {
        const note = o.annotations?.[q]?.notes
        return `"${q}"="${a}"${note ? ` user notes: ${note}` : ""}`
      })
      return { content: [{ type: "text", text: `User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers in mind.` }] }
    }
    if (call.name in FILE_TOOLS) return runFileTool(this.fileCtx, call.name, call.input)
    // The app's registry tools: input validated, identity from the app, gates enforced (never from the model).
    if (this.ctx.tools.list().some((t) => t.name === call.name)) return this.ctx.tools.call(call.name, call.input)
    return { content: [{ type: "text", text: `Error: Unknown tool ${call.name}.` }], isError: true }
  }

  private finish(turn: string, o: Outcome, tokens: AgentTokenUsage, steps: number, startedAt: number) {
    const base = { durationMs: Date.now() - startedAt, turns: steps, usage: this.usage(tokens, true), queued: this.queue.length }
    const itemId = `end:${turn}`
    this.running = false
    this.interrupting = false
    this.turnAbort.abort(ABORTED) // anything still waiting on the user for this turn is over
    if (o.kind === "interrupted") {
      const fix = unansweredToolResults(this.store.messages)
      if (fix) this.store.append(fix)
      // What's queued now was sent after Stop and still runs.
      this.host.emit({ type: "run.interrupted", result: { ...base, subtype: "interrupted", isError: false, text: "" } }, { itemId })
    } else if (o.kind === "failed") {
      if (o.auth) this.host.emit({ type: "notice", level: "error", code: API_AUTH_CODE, text: o.error }, { itemId: `auth:${turn}` })
      this.host.emit({ type: "run.failed", error: o.error, result: { ...base, subtype: "error", isError: true, text: o.error } }, { itemId })
    } else if (o.kind === "max_steps") {
      const text = `Stopped after ${o.steps} steps (the limit for one request). Say “keep going” to continue.`
      this.host.emit({ type: "run.completed", result: { ...base, subtype: "error_max_turns", isError: true, text } }, { itemId })
    } else if (o.kind === "refusal") {
      this.host.emit({ type: "run.completed", result: { ...base, subtype: "refusal", isError: true, text: "The model declined this request. Try rephrasing it." } }, { itemId })
    } else this.host.emit({ type: "run.completed", result: { ...base, subtype: "success", isError: false, text: o.text } }, { itemId })
    // Everything queued goes in one turn: answered together instead of one stale turn each.
    const next = this.queue.splice(0)
    if (next.length && this._alive) void this.runTurn(next)
  }
}

/** A user message as conversation blocks; `late` marks one sent while the designer was working. */
function userBlocks(t: AgentTurnInput, late = false): ConvBlock[] {
  const text = t.agentText || t.text || "(see the attached image)"
  const out: ConvBlock[] = [{ type: "text", text: late ? `(New message from the user, sent while you were working:)\n${text}` : text }]
  for (const i of t.images) out.push({ type: "image", mediaType: i.mediaType, data: i.data })
  return out
}

// -------------------------------------------------------------------------------------------------
// Runtime
// -------------------------------------------------------------------------------------------------

export class ApiRuntime implements AgentRuntime {
  readonly kind = "api"
  readonly capabilities = apiCapabilities()
  readonly info = {
    label: "API connection",
    blurb: "Talks to a model with an API key. Nothing to install. For tinkerers.",
    authKinds: ["api-key" as const],
    apiKeyLabel: "API key",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    homepage: "https://docs.claude.com/en/api/overview",
  }

  constructor(private deps: ApiDeps = defaultApiDeps) {}

  create(host: AdapterHost): AgentAdapter {
    return new ApiAdapter(host, this.deps)
  }

  async probe(): Promise<AgentRuntimeProbe> {
    return {
      runtime: "api",
      installed: true,
      version: "built in",
      auth: { method: "api-key", status: "unknown" },
      models: ANTHROPIC_SUGGESTED_MODELS,
      defaultModel: ANTHROPIC_DEFAULT_MODEL,
      capabilities: this.capabilities,
      effortLevels: API_EFFORTS,
      ready: true,
      detail: "Built into Crease: nothing to install. Needs an API key (or a local server address).",
    }
  }

  async listModels(profile: AgentProfileSnapshot): Promise<AgentModelList> {
    let a: ApiAccess
    try {
      a = apiAccess(this.deps, profile)
    } catch (e) {
      return { models: [], defaultModel: profile.apiProtocol === "openai-chat" ? null : ANTHROPIC_DEFAULT_MODEL, error: (e as Error).message }
    }
    try {
      const models = await a.endpoint.listModels(AbortSignal.timeout(10_000))
      const def = a.protocol === "anthropic" ? (models.some((m) => m.value === ANTHROPIC_DEFAULT_MODEL) ? ANTHROPIC_DEFAULT_MODEL : (models[0]?.value ?? null)) : (models[0]?.value ?? null)
      return { models, defaultModel: def }
    } catch (e) {
      return { models: [], defaultModel: null, error: e instanceof EndpointError && e.kind === "auth" ? "The key was refused." : (e as Error).message }
    }
  }

  /** "Test connection": key saved, endpoint answers the model list (free), the model is there. No model call. */
  async checkConnection(profile: AgentProfileSnapshot): Promise<AgentConnectionResult> {
    const steps: AgentConnectionStep[] = []
    let a: ApiAccess
    try {
      a = apiAccess(this.deps, profile)
    } catch (e) {
      const msg = (e as Error).message
      steps.push({ label: msg === API_NO_KEY ? "API key saved" : "Endpoint", ok: false, detail: msg })
      return { ok: false, steps, summary: msg }
    }
    const spec = ENDPOINTS[a.protocol]
    steps.push({ label: a.apiKey ? "API key saved" : "No key needed (local server)", ok: true, detail: `${spec.label} at ${a.baseUrl}` })
    let models: { value: string; label: string }[]
    try {
      models = await a.endpoint.listModels(AbortSignal.timeout(10_000))
    } catch (e) {
      const err = e instanceof EndpointError ? e : new EndpointError((e as Error).message, "other")
      const auth = err.kind === "auth"
      steps.push({ label: auth ? "API key accepted" : "Endpoint answers", ok: auth ? false : null, detail: auth ? "The key was refused. Paste a new one." : err.message })
      return { ok: false, steps, summary: auth ? "Replace the key, then test again." : `Couldn't read the model list (${err.message}). Check the address and that the server is running.` }
    }
    steps.push({ label: a.apiKey ? "API key accepted" : "Endpoint answers", ok: true, detail: `${models.length} model${models.length === 1 ? "" : "s"} available (no charge for this check).` })
    const model = a.model
    if (model) steps.push({ label: `Model ${model}`, ok: models.some((m) => m.value === model) ? true : null, detail: models.some((m) => m.value === model) ? "listed" : "not in the endpoint's list; it may still work" })
    else steps.push({ label: "Model", ok: false, detail: "Pick one of the listed models." })
    if (spec.untested) steps.push({ label: "Tool calls, images, usage", ok: null, detail: `untested on this server: ${spec.untested}` })
    const ready = !!model
    return {
      ok: ready,
      steps,
      models,
      summary: !ready
        ? "Connected. Now pick a model."
        : a.protocol === "anthropic"
          ? this.deps.priced(a.endpoint)
            ? "Ready. Messages are billed to this API key; costs shown are computed from Anthropic's published prices."
            : "Ready. This endpoint isn't Anthropic's own, so Crease shows token counts but no costs."
          : "Connected. Crease shows token counts but no costs for this server, and its tool calling is untested.",
    }
  }

  /** "Send a test message": one tiny paid turn, no tools, no project. */
  async testMessage(profile: AgentProfileSnapshot): Promise<AgentConnectionResult> {
    let a: ApiAccess
    try {
      a = apiAccess(this.deps, profile, { needModel: true })
    } catch (e) {
      return { ok: false, steps: [], summary: (e as Error).message }
    }
    const req: ModelRequest = {
      model: a.model!,
      system: "You are a connection test for Crease.",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "This is a connection test from Crease. Reply with exactly: Ready to design." }] }],
      maxTokens: 1024,
      effort: "low",
    }
    try {
      const r = await a.endpoint.stream(req, noSink, AbortSignal.timeout(90_000))
      const reply = r.message.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("")
        .trim()
      const cost = this.deps.priced(a.endpoint) ? responseCostUsd(r.model || a.model, r.usage) : null
      if (!reply) return { ok: false, steps: [{ label: "Test message", ok: false, detail: `No reply text (stop: ${r.rawStop ?? "?"}).` }], summary: "It answered without text.", costUsd: cost }
      return {
        ok: true,
        steps: [{ label: "Test message", ok: true, detail: `Replied: “${reply.slice(0, 200)}”` }],
        reply: reply.slice(0, 500),
        costUsd: cost,
        summary: cost !== null ? `It answered. That cost $${cost.toFixed(4)} on your API key.` : "It answered. This endpoint doesn't report cost; tokens only.",
      }
    } catch (e) {
      const err = e instanceof EndpointError ? e : new EndpointError((e as Error).message, "other")
      return { ok: false, steps: [{ label: "Test message", ok: false, detail: err.message }], summary: err.kind === "auth" ? "The key was refused. Replace it, then test again." : `It didn't answer: ${err.message}` }
    }
  }

  async fork(nativeSessionId: string, o: { cwd: string }): Promise<{ nativeSessionId: string }> {
    const id = randomUUID()
    ConversationStore.copy(apiSessionPath(o.cwd, nativeSessionId), apiSessionPath(o.cwd, id))
    return { nativeSessionId: id }
  }
}

export const apiRuntime = new ApiRuntime()
