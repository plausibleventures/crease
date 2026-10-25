// The direct API runtime's conversation (R11f): the app owns the transcript the model sees, so it keeps it.
//
// Messages are kept in a protocol-neutral shape (ConvMessage: text, images, thinking, tool calls, tool results), with
// the provider's own blocks alongside (`native`) so an Anthropic assistant turn goes back byte-for-byte as it came
// (thinking signatures, block order: preserved thinking needs an append-only history). Endpoints convert to and from
// their wire format (anthropic.ts, openai.ts).
//
// Store: <project>/.studio/sessions/api/<sessionId>.jsonl, append-only records: {t:"meta"} once, {t:"msg", m} per
// message, {t:"snapshot", messages} after the app rewrote the history (trimming, thinking stripped). Replay = the last
// snapshot plus the messages after it. Resume and fork rebuild from this file (there is no provider-side session).
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type ConvBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  /** Model reasoning. `signature` (Anthropic) binds it to this conversation; blocks without one are never sent back. */
  | { type: "thinking"; text: string; signature?: string | null; redacted?: string | null }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; content: ({ type: "text"; text: string } | { type: "image"; mediaType: string; data: string })[] }

export interface ConvMessage {
  role: "user" | "assistant"
  content: ConvBlock[]
  /** The provider's own content for this message, sent back verbatim while the history is untouched. */
  native?: { protocol: string; model?: string | null; content: unknown[] } | null
}

export interface ConvMeta {
  t: "meta"
  v: 1
  createdAt: string
}

type Record_ = ConvMeta | { t: "msg"; m: ConvMessage } | { t: "snapshot"; at: string; reason: string; messages: ConvMessage[] }

export const apiSessionsDir = (projectRoot: string) => join(projectRoot, ".studio", "sessions", "api")
export const apiSessionPath = (projectRoot: string, sessionId: string) => join(apiSessionsDir(projectRoot), `${sessionId.replace(/[^\w.-]/g, "_")}.jsonl`)

export class ConversationStore {
  messages: ConvMessage[] = []

  constructor(readonly path: string) {}

  get exists() {
    return existsSync(this.path)
  }

  /** Replay the file. Unreadable lines are skipped (a crash mid-append leaves at most one). */
  load(): ConvMessage[] {
    const out: ConvMessage[] = []
    let msgs = out
    if (!existsSync(this.path)) return (this.messages = [])
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue
      let r: Record_
      try {
        r = JSON.parse(line)
      } catch {
        continue
      }
      if (r.t === "msg" && r.m && Array.isArray(r.m.content)) msgs.push(r.m)
      else if (r.t === "snapshot" && Array.isArray(r.messages)) msgs = [...r.messages]
    }
    return (this.messages = msgs)
  }

  private write(r: Record_) {
    mkdirSync(dirname(this.path), { recursive: true })
    if (!existsSync(this.path)) writeFileSync(this.path, JSON.stringify({ t: "meta", v: 1, createdAt: new Date().toISOString() } satisfies ConvMeta) + "\n")
    appendFileSync(this.path, JSON.stringify(r) + "\n")
  }

  append(m: ConvMessage) {
    this.messages.push(m)
    this.write({ t: "msg", m })
  }

  /** Replace the whole history (after trimming / stripping thinking). */
  replace(messages: ConvMessage[], reason: string) {
    this.messages = messages
    this.write({ t: "snapshot", at: new Date().toISOString(), reason, messages })
  }

  /** Copy for a fork ("Try another idea"): the new session starts from the same history. */
  static copy(from: string, to: string) {
    mkdirSync(dirname(to), { recursive: true })
    if (existsSync(from)) copyFileSync(from, to)
  }
}

// -------------------------------------------------------------------------------------------------
// History hygiene
// -------------------------------------------------------------------------------------------------

/**
 * Every tool call must be answered before the next model request. A turn that was stopped (or a crash) between the
 * model's call and its result leaves calls unanswered: returns the user message that answers them, or null.
 */
export function unansweredToolResults(messages: ConvMessage[], text = "Not run: the user stopped this request."): ConvMessage | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "assistant") return null
  const calls = last.content.filter((b): b is Extract<ConvBlock, { type: "tool_use" }> => b.type === "tool_use")
  if (!calls.length) return null
  return { role: "user", content: calls.map((c) => ({ type: "tool_result", toolUseId: c.id, isError: true, content: [{ type: "text", text }] })) }
}

/** Remove every thinking block (and the verbatim provider copies that hold them). Text and tool calls stay. */
export function stripThinking(messages: ConvMessage[]): { messages: ConvMessage[]; changed: boolean } {
  let changed = false
  const out = messages.map((m) => {
    if (m.role !== "assistant") return m
    const has = m.content.some((b) => b.type === "thinking")
    if (!has && !m.native) return m
    changed ||= has
    const content = m.content.filter((b) => b.type !== "thinking")
    return { role: m.role, content: content.length ? content : [{ type: "text" as const, text: "(no reply text)" }] }
  })
  return { messages: out, changed }
}

/** Rough token count for trimming decisions when the provider doesn't report one (4 chars/token, ~1.6k per image). */
export function estimateTokens(messages: ConvMessage[], extra = ""): number {
  let chars = extra.length
  let images = 0
  const walk = (b: ConvBlock) => {
    if (b.type === "text") chars += b.text.length
    else if (b.type === "image") images++
    else if (b.type === "thinking") chars += b.text.length
    else if (b.type === "tool_use") chars += JSON.stringify(b.input ?? {}).length + b.name.length
    else if (b.type === "tool_result") for (const c of b.content) if (c.type === "text") chars += c.text.length; else images++
  }
  for (const m of messages) for (const b of m.content) walk(b)
  return Math.ceil(chars / 4) + images * 1600
}

/** Tools whose calls and results are the user's decisions and the plan: never trimmed. */
export const KEEP_TOOLS = new Set(["AskUserQuestion", "share_plan"])
/** Tool inputs that carry whole files: their bodies go first when trimming (the file is on disk). */
const BULKY_INPUT_FIELDS = ["content", "new_string", "old_string"]

export const TRIMMED_RESULT = "[Earlier tool output removed to save space. Run the tool again if you need it.]"
export const TRIMMED_IMAGE = "[Earlier image removed to save space.]"

/**
 * Context trimming: shrink the history to about `target` tokens without losing the conversation's meaning. In order,
 * oldest first, never touching the last `keepRecent` messages: images, then tool outputs, then bulky tool inputs (file
 * bodies). Text the user wrote and the model said, tool calls themselves, questions and their answers and the shared
 * plan all stay. Thinking is stripped everywhere: an edited history invalidates it (preserved thinking), and it's the
 * least useful thing to keep. Returns null when there's nothing to trim.
 */
export function trimHistory(messages: ConvMessage[], target: number, keepRecent = 4): { messages: ConvMessage[]; before: number; after: number } | null {
  const before = estimateTokens(messages)
  let out: ConvMessage[] = stripThinking(messages).messages.map((m) => ({ role: m.role, content: m.content.map((b) => ({ ...b })) as ConvBlock[] }))
  const names = new Map<string, string>()
  for (const m of out) for (const b of m.content) if (b.type === "tool_use") names.set(b.id, b.name)
  const cut = Math.max(0, out.length - keepRecent)
  const passes: ((b: ConvBlock) => ConvBlock | null)[] = [
    // 1. images (user photos stay: they are the brief; tool pictures go)
    (b) => (b.type === "tool_result" && b.content.some((c) => c.type === "image") && !KEEP_TOOLS.has(names.get(b.toolUseId) ?? "") ? { ...b, content: [...b.content.filter((c) => c.type === "text"), { type: "text", text: TRIMMED_IMAGE }] } : null),
    // 2. tool outputs
    (b) =>
      b.type === "tool_result" && !KEEP_TOOLS.has(names.get(b.toolUseId) ?? "") && !(b.content.length === 1 && b.content[0].type === "text" && b.content[0].text === TRIMMED_RESULT)
        ? { ...b, content: [{ type: "text", text: TRIMMED_RESULT }] }
        : null,
    // 3. bulky tool inputs (file bodies)
    (b) => {
      if (b.type !== "tool_use" || KEEP_TOOLS.has(b.name) || !b.input || typeof b.input !== "object") return null
      const inp = { ...(b.input as Record<string, unknown>) }
      let hit = false
      for (const f of BULKY_INPUT_FIELDS) {
        if (typeof inp[f] !== "string" || (inp[f] as string).length <= 200) continue
        inp[f] = `[${(inp[f] as string).length} characters, removed to save space]`
        hit = true
      }
      return hit ? { ...b, input: inp } : null
    },
  ]
  let changed = estimateTokens(out) !== before
  for (const pass of passes) {
    for (let i = 0; i < cut && estimateTokens(out) > target; i++) {
      const m = out[i]
      let touched = false
      const content = m.content.map((b) => {
        const r = pass(b)
        if (r) touched = true
        return r ?? b
      })
      if (touched) {
        out = out.map((x, j) => (j === i ? { role: x.role, content } : x))
        changed = true
      }
    }
    if (estimateTokens(out) <= target) break
  }
  if (!changed) return null
  return { messages: out, before, after: estimateTokens(out) }
}
