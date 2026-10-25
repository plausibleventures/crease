// Claude Agent SDK messages -> normalized AgentEvents. Used live by the Claude adapter and on read to migrate legacy
// transcripts (raw SDK messages), so an old session and a new one render through the same reducer.
//
// Stateful per stream: it pairs streamed blocks (stream_event) with the complete assistant message that follows,
// remembers the user's last input (Claude Code echoes it), and shows "Session started" once. Item ids are stable:
// streamed blocks `t:<messageId>#<index>`, tool calls their tool_use id, other blocks `<base>:<i>` where base is
// the SDK message uuid (or the caller's fallback).
import type { AgentBilling, AgentEvent, AgentImage, AgentRunResult, AgentUsage } from "../../../../shared/types"

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface NormalizedEvent {
  event: AgentEvent
  itemId: string | null
  /** false = live only (deltas, input fragments). */
  persist: boolean
}

export interface NormalizeOptions {
  /** How the session is billed (live: from the auth in use; migrated transcripts: "unknown"). */
  billing: AgentBilling | "unknown"
  /** The user stopped the turn: its result becomes run.interrupted. */
  interrupted?: boolean
}

// Claude Code echoes slash commands (e.g. the /model switch) as user text wrapped in these tags.
const LOCAL_COMMAND_RE = /^\s*<(local-command-stdout|local-command-stderr|command-name|command-message|command-args|local-command-caveat)>/
const TOOL_USE = new Set(["tool_use", "server_tool_use", "mcp_tool_use"])

export function contentToText(c: any): string {
  if (c == null) return ""
  if (typeof c === "string") return c
  if (Array.isArray(c))
    return c
      .map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "" : typeof b === "string" ? b : ""))
      .filter(Boolean)
      .join("\n")
  if (typeof c === "object" && typeof c.text === "string") return c.text
  try {
    return JSON.stringify(c)
  } catch {
    return String(c)
  }
}

export function contentImages(c: any): AgentImage[] {
  const out: AgentImage[] = []
  const walk = (b: any) => {
    if (!b || typeof b !== "object") return
    if (b.type === "image") {
      const src = b.source ?? {}
      if (src.type === "base64" && src.data) out.push({ mediaType: src.media_type ?? "image/png", data: src.data })
      else if (src.type === "url" && src.url) out.push({ mediaType: "image/png", url: src.url })
      else if (b.data) out.push({ mediaType: b.mimeType ?? b.mime_type ?? "image/png", data: b.data })
    }
  }
  if (Array.isArray(c)) c.forEach(walk)
  return out
}

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null)

/** Usage from a result: cumulative session cost (studio_cost_usd, stamped by the adapter; older: total_cost_usd). */
export function resultUsage(m: any, billing: AgentBilling | "unknown"): AgentUsage {
  const cost = num(m.studio_cost_usd) ?? num(m.total_cost_usd)
  const u = m.usage
  return {
    tokens:
      u && typeof u === "object"
        ? {
            input: num(u.input_tokens),
            output: num(u.output_tokens),
            cacheRead: num(u.cache_read_input_tokens),
            cacheWrite: num(u.cache_creation_input_tokens),
          }
        : null,
    // Claude reports its cost at API list prices. With an API key that's what is billed; on a plan login it's an
    // API-equivalent estimate and the plan's limits are what count.
    billedUsd: billing === "api" ? cost : null,
    estimatedApiUsd: cost,
    billing,
    subscription: null,
    final: true,
  }
}

export function resultOf(m: any, billing: AgentBilling | "unknown"): AgentRunResult {
  return {
    subtype: String(m.subtype ?? "result"),
    isError: !!m.is_error || (typeof m.subtype === "string" && m.subtype.startsWith("error")),
    text: typeof m.result === "string" ? m.result : Array.isArray(m.errors) ? m.errors.join("\n") : "",
    durationMs: num(m.duration_ms),
    turns: num(m.num_turns),
    usage: resultUsage(m, billing),
    queued: num(m.queued_turn_count),
  }
}

/** The run-end event for a Claude `result` message. */
export function runEndEvent(m: any, opts: NormalizeOptions): AgentEvent {
  const result = resultOf(m, opts.billing)
  if (opts.interrupted) return { type: "run.interrupted", result }
  if (result.isError) return { type: "run.failed", error: result.text || result.subtype, result }
  return { type: "run.completed", result }
}

export class ClaudeNormalizer {
  private lastUserText: string | null = null
  private sessionStarted = false
  private currentMsgId: string | null = null
  /** per assistant message id: streamed text/thinking items in order + match cursor */
  private streamed = new Map<string, { items: { id: string; kind: "text" | "thinking"; text: string; done: boolean }[]; cursor: number }>()
  /** stream block (`<msgId>#<index>`) -> item */
  private blocks = new Map<string, { id: string; kind: "text" | "thinking" | "tool"; name?: string; partial: string; parent: string | null }>()
  private anon = 0

  /** The user's own message for this turn (Claude Code echoes it back as a user message). */
  userInput(text: string) {
    this.lastUserText = text
  }

  /**
   * Convert one SDK message. `base` is a fallback id for items when the message has no uuid (unique per message
   * within the session).
   */
  convert(m: any, base: string, opts: NormalizeOptions): NormalizedEvent[] {
    const out: NormalizedEvent[] = []
    const add = (event: AgentEvent, itemId: string | null, persist = true) => out.push({ event, itemId, persist })
    if (!m || typeof m !== "object") {
      add({ type: "native", message: m }, base)
      return out
    }
    const id = typeof m.uuid === "string" && m.uuid ? m.uuid : base
    const parent: string | null = m.parent_tool_use_id ?? null
    switch (m.type) {
      case "stream_event":
        this.stream(m.event, parent, base, add)
        return out
      case "assistant":
        this.assistant(m, id, parent, add)
        return out
      case "user":
        this.user(m, id, add)
        return out
      case "result":
        add(runEndEvent(m, opts), `end:${id}`)
        return out
      case "system":
        // The SDK sends many system messages (init every turn, thinking_tokens per chunk, status, hooks…). Show the
        // first init and context compaction; drop the rest.
        if (m.subtype === "init") {
          if (!this.sessionStarted) {
            this.sessionStarted = true
            add(
              {
                type: "notice",
                level: "info",
                code: "session.started",
                text: `Session started${m.model ? ` · ${m.model}` : ""}`,
                data: {
                  model: m.model ?? null,
                  cwd: typeof m.cwd === "string" ? m.cwd : null,
                  version: typeof m.claude_code_version === "string" ? m.claude_code_version : null,
                },
              },
              `init:${id}`
            )
          }
        } else if (m.subtype === "compact_boundary")
          add({ type: "notice", level: "info", code: "context.compacted", text: "Context compacted" }, `compact:${id}`)
        return out
      case "tool_progress":
      case "auth_status":
      case "keep_alive":
      case "rate_limit_event":
        return out
      default:
        add({ type: "native", message: m }, id)
        return out
    }
  }

  private stream(ev: any, parent: string | null, base: string, add: (e: AgentEvent, itemId: string | null, persist?: boolean) => void) {
    if (!ev || typeof ev !== "object") return
    switch (ev.type) {
      case "message_start": {
        this.currentMsgId = ev.message?.id ?? `anon-${base}-${this.anon++}`
        if (!this.streamed.has(this.currentMsgId!)) this.streamed.set(this.currentMsgId!, { items: [], cursor: 0 })
        return
      }
      case "content_block_start": {
        const msgId = this.currentMsgId ?? "anon"
        const cb = ev.content_block ?? {}
        const bkey = `${msgId}#${ev.index}`
        if (cb.type === "text" || cb.type === "thinking") {
          const itemId = `t:${bkey}`
          const text = (cb.type === "text" ? cb.text : cb.thinking) ?? ""
          this.blocks.set(bkey, { id: itemId, kind: cb.type, partial: text, parent })
          const entry = this.streamed.get(msgId) ?? { items: [], cursor: 0 }
          entry.items.push({ id: itemId, kind: cb.type, text, done: false })
          this.streamed.set(msgId, entry)
          add({ type: "message.delta", role: "assistant", kind: cb.type, delta: text, parentToolId: parent }, itemId, false)
        } else if (TOOL_USE.has(cb.type)) {
          this.blocks.set(bkey, { id: cb.id, kind: "tool", name: cb.name ?? "tool", partial: "", parent })
          add(
            {
              type: "tool.started",
              name: cb.name ?? "tool",
              ...(cb.input && Object.keys(cb.input).length ? { input: cb.input } : {}),
              parentToolId: parent,
              stepId: msgId,
            },
            cb.id
          )
        }
        return
      }
      case "content_block_delta": {
        const b = this.blocks.get(`${this.currentMsgId ?? "anon"}#${ev.index}`)
        if (!b) return
        const d = ev.delta ?? {}
        if (b.kind !== "tool" && (d.type === "text_delta" || d.type === "thinking_delta")) {
          const delta = (d.type === "text_delta" ? d.text : d.thinking) ?? ""
          b.partial += delta
          const s = this.streamed.get(this.currentMsgId ?? "anon")?.items.find((x) => x.id === b.id)
          if (s) s.text = b.partial
          add({ type: "message.delta", role: "assistant", kind: b.kind, delta, parentToolId: b.parent }, b.id, false)
        } else if (b.kind === "tool" && d.type === "input_json_delta") {
          b.partial += d.partial_json ?? ""
          add({ type: "tool.started", name: b.name ?? "tool", inputDelta: d.partial_json ?? "", parentToolId: b.parent }, b.id, false)
        }
        return
      }
      case "content_block_stop": {
        const b = this.blocks.get(`${this.currentMsgId ?? "anon"}#${ev.index}`)
        if (!b) return
        if (b.kind === "tool") {
          if (!b.partial) return
          try {
            // live only: the assistant message that follows carries the input and is what's kept
            add({ type: "tool.started", name: b.name ?? "tool", input: JSON.parse(b.partial), parentToolId: b.parent }, b.id, false)
          } catch {
            /* incomplete JSON: wait for the assistant message */
          }
          return
        }
        // The block is complete: keep it (the assistant message only re-sends it if the text differs).
        const s = this.streamed.get(this.currentMsgId ?? "anon")?.items.find((x) => x.id === b.id)
        if (s) s.done = true
        add({ type: "message.completed", role: "assistant", kind: b.kind, text: b.partial, parentToolId: b.parent, stepId: this.currentMsgId }, b.id)
        return
      }
      default:
        return
    }
  }

  private assistant(m: any, id: string, parent: string | null, add: (e: AgentEvent, itemId: string | null, persist?: boolean) => void) {
    const msg = m.message ?? {}
    const msgId: string = msg.id ?? id
    const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : []
    const entry = this.streamed.get(msgId) ?? { items: [], cursor: 0 }
    this.streamed.set(msgId, entry)
    content.forEach((b: any, i: number) => {
      if (!b || typeof b !== "object") return
      if (b.type === "text" || b.type === "thinking") {
        const full: string = (b.type === "text" ? b.text : b.thinking) ?? ""
        // match against the next streamed block of the same kind for this message
        while (entry.cursor < entry.items.length) {
          const s = entry.items[entry.cursor++]
          if (s.kind !== b.type) continue
          if (!s.done || (full && full !== s.text))
            add({ type: "message.completed", role: "assistant", kind: b.type, text: full || s.text, parentToolId: parent, stepId: msgId }, s.id)
          return
        }
        if (!full.trim()) return
        add({ type: "message.completed", role: "assistant", kind: b.type, text: full, parentToolId: parent, stepId: msgId }, `${id}:${i}`)
      } else if (TOOL_USE.has(b.type)) {
        add({ type: "tool.started", name: b.name ?? "tool", input: b.input, parentToolId: parent, stepId: msgId }, b.id)
      } else if (b.type === "redacted_thinking") {
        // skip
      } else if (typeof b.type === "string" && b.type.endsWith("tool_result")) {
        add(toolResult(b), b.tool_use_id)
      } else {
        add({ type: "native", message: b }, `${id}:${i}`)
      }
    })
    // A missing/expired login gets one plain-language notice (code claude_auth) with a sign-in button instead.
    if (m.error && m.error !== "authentication_failed") add({ type: "notice", level: "error", text: String(m.error) }, `${id}:err`)
  }

  private user(m: any, id: string, add: (e: AgentEvent, itemId: string | null, persist?: boolean) => void) {
    const content = m.message?.content
    if (typeof content === "string") {
      if (content !== this.lastUserText && !m.isSynthetic && !LOCAL_COMMAND_RE.test(content))
        add({ type: "message.completed", role: "user", kind: "text", text: content }, id)
      return
    }
    if (!Array.isArray(content)) return
    const texts: string[] = []
    for (const b of content) {
      if (b?.type === "tool_result") add(toolResult(b), b.tool_use_id)
      else if (b?.type === "text" && typeof b.text === "string") texts.push(b.text)
    }
    const t = texts.join("\n").trim()
    if (t && t !== this.lastUserText && !m.isSynthetic && !m.parent_tool_use_id && !LOCAL_COMMAND_RE.test(t))
      add({ type: "message.completed", role: "user", kind: "text", text: t }, id)
  }
}

function toolResult(b: any): AgentEvent {
  return { type: "tool.completed", isError: !!b.is_error, text: contentToText(b.content), images: contentImages(b.content) }
}
