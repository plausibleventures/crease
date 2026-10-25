// Agent runtime adapter contract.
//
// A runtime (Claude Code via the Agent SDK today; Codex, Grok, a direct API loop later) is wrapped by an adapter.
// The session coordinator (../coordinator.ts) owns sessions and runs, persistence, questions, approval tracking and
// status; it picks a runtime and talks to it only through this interface. The adapter turns native messages into
// normalized AgentEvents (shared/types.ts) and exposes the app's tools (BoundTools, identity bound by the app).
import type {
  AgentConnectionResult,
  AgentEvent,
  AgentInputImage,
  AgentModelList,
  AgentProfileSnapshot,
  AgentQuestion,
  AgentRuntimeCapabilities,
  AgentRuntimeInfo,
  AgentRuntimeProbe,
  PointAnnotation,
} from "../../../shared/types"
import type { PermissionAsk, PermissionOutcome } from "../permissions"
import type { PolicyOptions } from "../policy"
import type { BoundTools } from "../registry"

/**
 * The effective agent profile frozen for a session (R11b): runtime, model, how it signs in (credentialRef: read the
 * key with getSecret(ref) at start; never copy it into events/logs), effort, budget, policy. Kept as `AgentProfile`
 * for adapters written against R11a (they read `.runtime` / `.model`).
 */
export type AgentProfile = AgentProfileSnapshot

/** Everything a runtime needs to start (or resume) a session. Built by the coordinator; frozen for the session. */
export interface AgentSessionContext {
  projectId: string
  /** App session id. Claude pins its own session id to it. */
  sessionId: string
  /** Project folder: the workspace the runtime may edit. */
  cwd: string
  /** The runtime's own session (native id) to resume, or null for a new one. */
  resume: string | null
  /** App instructions appended to the runtime's own system prompt (brief, machine limits, lessons). */
  instructions: string
  /** The app's tools, bound to this session (the runtime can't choose the project/run). */
  tools: BoundTools
  /** What the runtime's own tools may touch (printer hosts, secret files). */
  policy: PolicyOptions
  /** Session cost carried over from earlier runs of this session (resume), so totals stay cumulative. */
  priorCostUsd: number
  maxTurns?: number
  profile: AgentProfileSnapshot
}

/** One user turn. `text` is what the user typed (shown); `agentText` is what the model gets (with pin notes). */
export interface AgentTurnInput {
  /** The app's run id for this message (absent in tools/tests that drive an adapter directly). */
  id?: string
  text: string
  agentText: string
  images: AgentInputImage[]
  annotations: PointAnnotation[]
}

/** Answers to one question round, or why there are none. */
export type QuestionOutcome =
  { answered: true; answers: Record<string, string>; annotations?: Record<string, { notes: string }> } | { answered: false; message: string }

/** Raw question input from the runtime: {questions: [{question, header, options, multiSelect}]} (sanitized by the app). */
export type QuestionInput = Record<string, unknown> & { questions?: unknown }

export interface EmitOptions {
  /** Timeline item the event belongs to. */
  itemId?: string | null
  /** false = live only (streaming deltas, estimates): sent over WS, not written to the transcript. Default true. */
  persist?: boolean
}

/** The coordinator's side, handed to an adapter. */
export interface AdapterHost {
  /** A normalized event. The coordinator adds the envelope (ids, seq, run, revision), dedupes and persists. */
  emit(event: AgentEvent, opts?: EmitOptions): void
  /** A native runtime message, redacted, kept for diagnostics and legacy replay (never rendered from). */
  native(message: unknown, opts?: { persist?: boolean }): void
  /** Ask the user (app dialog). Resolves when answered, or refused when the turn is stopped / session closed. */
  askUser(input: QuestionInput, opts: { signal: AbortSignal; toolUseID?: string }): Promise<QuestionOutcome>
  /**
   * Ask the user to allow something (permission.requested + a card). Only for requests the app's policy didn't already
   * refuse. Resolves deny when the turn is stopped / the session closes.
   */
  askPermission(ask: PermissionAsk, opts: { signal: AbortSignal; requestId?: string }): Promise<PermissionOutcome>
  /** A runtime-native tool call (file write/edit, shell) was allowed: lets the app track design changes. */
  nativeToolAllowed(name: string, input: Record<string, unknown>): void
  /** The runtime reports a different session id than the one it was started with. */
  nativeSessionChanged(id: string): void
  /**
   * The model has this message now (input.id): its turn started, or it was folded/steered into the running turn. A
   * message sent while another run is open waits ("queued" in the chat) until this. Optional for test hosts.
   */
  received?(inputId: string): void
  /** The runtime stopped (process ended). `error` if it ended badly. */
  ended(opts: { error?: string }): void
}

export interface AgentAdapter {
  /** The runtime process/connection is up. */
  readonly alive: boolean
  /** Start or resume (ctx.resume). Returns the runtime's own session id, if it has one. */
  start(ctx: AgentSessionContext): Promise<{ nativeSessionId: string | null }>
  /**
   * A user message (the coordinator has emitted run.started). Idle: starts a turn. While a turn runs: fold it into
   * that turn when the runtime can (Claude's queue, Codex turn/steer, the API loop between steps), else queue it for
   * the next turn. Either way call host.received(input.id) when the model gets it, and report what's still queued in
   * the run end's result.queued (Stop drops it).
   */
  send(input: AgentTurnInput): void
  /** Deliver answers to a pending question (runtimes that ask via host.askUser are answered through that promise). */
  answerQuestion(requestId: string, answers: Record<string, string>, notes?: Record<string, string>): void
  /** Answer a permission.requested. Runtimes without permission requests throw. */
  answerPermission(requestId: string, decision: { allow: boolean; message?: string }): void
  /** Stop the current turn; the runtime then ends the run (run.interrupted). */
  interrupt(): Promise<void>
  /** End the session and its child processes. Idempotent. */
  close(): void
  /** Switch model from the next turn (capabilities.modelSwitch). */
  setModel?(model: string): Promise<void>
}

export interface AgentRuntime {
  readonly kind: string
  readonly capabilities: AgentRuntimeCapabilities
  /** Agents screen card text (label, blurb, auth kinds…). Defaults to the entry in ./catalog.ts KNOWN_RUNTIMES. */
  readonly info?: Partial<Omit<AgentRuntimeInfo, "kind" | "available">>
  /**
   * The runtime picks its own session ids (Codex thread ids) instead of taking the app's. The coordinator then keeps
   * an app session id -> native id map (transcript.ts nativeRef) and resumes/forks by the native id.
   */
  readonly ownSessionIds?: boolean
  /** Install / version / auth / models: cheap, no model call. */
  probe(): Promise<AgentRuntimeProbe>
  /**
   * "Test connection" for a profile (R11c): install + sign-in/key check, no paid model call. Free provider calls
   * (e.g. listing models with the key) are fine. Absent = the Agents screen uses probe() only.
   */
  checkConnection?(profile: AgentProfileSnapshot): Promise<AgentConnectionResult>
  /**
   * R11f: models for a profile, discovered with its own key/endpoint (free). Absent = the probe's list is the same for
   * every profile.
   */
  listModels?(profile: AgentProfileSnapshot): Promise<AgentModelList>
  /** "Send a test message": one tiny paid turn with no tools, outside any project. Returns the reply + cost. */
  testMessage?(profile: AgentProfileSnapshot): Promise<AgentConnectionResult>
  create(host: AdapterHost): AgentAdapter
  /** Copy a native session so it can diverge (capabilities.fork). No model call. */
  fork?(nativeSessionId: string, opts: { cwd: string; title?: string }): Promise<{ nativeSessionId: string }>
  /** Kill every child process this runtime started (server exit). Synchronous. */
  shutdown?(): void
}

export type { AgentQuestion }
