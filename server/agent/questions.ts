// The app's question broker: a runtime asks (AdapterHost.askUser), the UI shows the questions and answers through
// POST …/agent/answer, and the waiting promise resolves with the answers (QuestionOutcome). Runtime-neutral.
//
// Claude's AskUserQuestion (the first user of this, adapted in runtime/claude/adapter.ts). SDK mechanism (verified against sdk.d.ts / sdk-tools.d.ts and a live session): AskUserQuestion is a
// permission-gated tool, so when it is NOT in allowedTools the CLI calls the host's canUseTool with
// toolName "AskUserQuestion" and input {questions}. The host shows the questions, then answers by
// returning {behavior: "allow", updatedInput: {...input, answers: {[questionText]: answer}, annotations?}}.
// The tool result the model sees is built from `answers` (multi-select = comma-separated labels).
// Returning deny (or the abort signal firing on interrupt) cancels the question.
import { randomUUID } from "node:crypto"
import type { AgentAnswers, AgentQuestion, AgentQuestionRequest } from "../../shared/types"
import { emit } from "../events"
import type { QuestionOutcome } from "./runtime/types"

interface Pending {
  request: AgentQuestionRequest
  input: Record<string, unknown>
  /** Close the card with this outcome (to the runtime while it waits; to `later` once detached). */
  resolve: (r: QuestionOutcome) => void
  /** Hand the runtime `now` and keep the card open; the user's answer then goes to `later`. */
  detach: (now: QuestionOutcome, later: (r: QuestionOutcome) => void) => void
  /** The turn that asked has ended or was paused; the card stays open and an answer goes to `later`. */
  detached?: boolean
}

const pending = new Map<string, Pending>()

export function listQuestions(projectId: string): AgentQuestionRequest[] {
  return [...pending.values()].filter((p) => p.request.projectId === projectId).map((p) => p.request)
}

/** Every pending question round, all projects (sync snapshot). */
export function listAllQuestions(): AgentQuestionRequest[] {
  return [...pending.values()].map((p) => p.request)
}

function sanitize(input: Record<string, unknown>): AgentQuestion[] {
  const qs = Array.isArray(input.questions) ? input.questions : []
  return qs.map((q: Record<string, unknown>) => ({
    question: String(q.question ?? ""),
    header: String(q.header ?? ""),
    multiSelect: Boolean(q.multiSelect),
    options: (Array.isArray(q.options) ? q.options : []).map((o: Record<string, unknown>) => ({
      label: String(o.label ?? ""),
      description: String(o.description ?? ""),
      ...(typeof o.preview === "string" && o.preview.trim() ? { preview: o.preview } : {}),
    })),
  }))
}

/**
 * Parks until the user answers in the UI, or the turn is interrupted. `onAsked` sees the request as shown.
 *
 * `keepOnAbort`: some runtimes end a turn without waiting for the answer (Codex 0.161 runs dynamic tools in the
 * background, so the model moves on and the turn ends with the question open). On abort it is asked whether to keep
 * the card: when it returns a handler, the waiting promise resolves now ("not answered yet") but the card stays, and
 * the user's answer goes to that handler instead (the coordinator sends it as the next message). Return null when
 * the user stopped the designer: the card closes as before.
 */
export function askUser(
  projectId: string,
  sessionId: string,
  input: Record<string, unknown>,
  opts: {
    signal: AbortSignal
    toolUseID?: string
    onAsked?: (request: AgentQuestionRequest) => void
    keepOnAbort?: () => ((r: QuestionOutcome) => void) | null
  },
): Promise<QuestionOutcome> {
  const requestId = opts.toolUseID ?? randomUUID()
  const request: AgentQuestionRequest = {
    requestId,
    projectId,
    sessionId,
    questions: sanitize(input),
    createdAt: new Date().toISOString(),
  }
  return new Promise<QuestionOutcome>((resolve) => {
    const close = (r: QuestionOutcome) => {
      if (!pending.delete(requestId)) return false
      emit({ type: "agent.question.resolved", projectId, requestId, answers: r.answered ? r.answers : null })
      return true
    }
    const p: Pending = {
      request,
      input,
      resolve: (r) => {
        if (close(r)) resolve(r)
      },
      detach: (now, later) => {
        if (p.detached || !pending.has(requestId)) return
        p.detached = true
        p.request = { ...p.request, paused: true }
        p.resolve = (r) => {
          if (close(r)) later(r)
        }
        resolve(now)
        emit({ type: "agent.question", request: p.request }) // the card shows it's paused
      },
    }
    pending.set(requestId, p)
    opts.signal.addEventListener(
      "abort",
      () => {
        if (!pending.has(requestId) || p.detached) return
        const later = opts.keepOnAbort?.()
        if (later) p.detach({ answered: false, message: NOT_YET }, later)
        else p.resolve({ answered: false, message: "The user stopped the agent before answering." })
      },
      { once: true },
    )
    opts.onAsked?.(request)
    emit({ type: "agent.question", request })
  })
}

export function answerQuestion(projectId: string, requestId: string, answers: AgentAnswers, notes?: Record<string, string>) {
  const p = pending.get(requestId)
  if (!p || p.request.projectId !== projectId) {
    throw Object.assign(new Error("No pending question with that id (already answered or cancelled)."), { statusCode: 404 })
  }
  const clean: AgentAnswers = {}
  for (const q of p.request.questions) {
    const a = answers[q.question]
    if (typeof a === "string" && a.trim()) clean[q.question] = a.trim()
  }
  if (!Object.keys(clean).length) throw Object.assign(new Error("No answers given."), { statusCode: 400 })
  const annotations: Record<string, { notes: string }> = {}
  for (const [k, v] of Object.entries(notes ?? {})) if (v?.trim() && k in clean) annotations[k] = { notes: v.trim() }
  p.resolve({ answered: true, answers: clean, ...(Object.keys(annotations).length ? { annotations } : {}) })
}

/** What the model reads when its turn ends before the user answered (the answer comes as their next message). */
export const NOT_YET = "The user hasn't answered yet. Their answer will arrive as their next message; end your turn now."

/** The answer line the model reads (Claude's AskUserQuestion wording, which the timeline's "You chose" row parses). */
export function answeredText(o: Extract<QuestionOutcome, { answered: true }>): string {
  const parts = Object.entries(o.answers).map(([q, a]) => {
    const note = o.annotations?.[q]?.notes
    return `"${q}"="${a}"${note ? ` user notes: ${note}` : ""}`
  })
  return `User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers in mind.`
}

/** What the model reads when the user pauses it at a question. */
export const PAUSED =
  "The user paused you to think or add something. Stop here: no more tools and no summary, end your turn now with at most one short line. Their answer, or a new message, arrives as their next message."

/** What the model reads when the user writes in the chat instead of answering (their message follows). */
export const REPLIED_IN_CHAT =
  "The user didn't pick an answer; they wrote a new message instead. Read it (it arrives next) and follow what it says."

/**
 * Pause at an open question: it hands its runtime PAUSED and stays open, and the user's answer goes to the handler
 * `later` gives (the coordinator sends it as the next message). False when that question isn't open or is paused.
 */
export function pauseQuestion(projectId: string, requestId: string, later: (r: QuestionOutcome) => void): boolean {
  const p = pending.get(requestId)
  if (!p || p.request.projectId !== projectId || p.detached) return false
  p.detach({ answered: false, message: PAUSED }, later)
  return true
}

/** A new message arrived while the designer waits on a question: the message is the reply, so the question closes. */
export function replyInChat(projectId: string) {
  for (const p of [...pending.values()]) {
    if (p.request.projectId === projectId && !p.detached) p.resolve({ answered: false, message: REPLIED_IN_CHAT })
  }
}

/** Close the cards whose turn already ended (the user typed a new message instead of answering). */
export function cancelDetachedQuestions(projectId: string) {
  for (const p of [...pending.values()]) {
    if (p.request.projectId === projectId && p.detached) p.resolve({ answered: false, message: "The user wrote a new message instead." })
  }
}

/** Cancel every pending question for a project (session closed / switched). */
export function cancelQuestions(projectId: string) {
  for (const p of [...pending.values()]) {
    if (p.request.projectId === projectId) p.resolve({ answered: false, message: "The session was closed before the user answered." })
  }
}
