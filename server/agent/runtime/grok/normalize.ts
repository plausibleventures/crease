// Grok ACP `session/update` notifications -> normalized AgentEvents (shared/types.ts). Items only: the turn lifecycle,
// usage and run results are the adapter's. Pure apart from its per-turn buffers, so protocol fixtures can drive it.
//
// ACP streams text/thought chunks without message ids, so a message block runs until the next tool call (or the turn
// end) and gets the id `<turn>:text:<n>` / `<turn>:thinking:<n>`. Tool rows use `<turn>:<toolCallId>`. Tools are named
// like Claude's so the timeline renders a Grok session the way it renders a Claude one: shell "Bash", write "Write",
// search_replace "Edit", read_file "Read", the app's MCP tools `mcp__studio__<name>`, ask_user_question
// "AskUserQuestion" (its result text is Claude's "User has answered your questions: …" wording).
import type { AgentEvent, AgentImage } from "../../../../shared/types"

export interface NormalizedOut {
  event: AgentEvent
  itemId: string | null
  persist?: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Grok's tool id for a tool call (`_meta["x.ai/tool"].name`, else the title of the first update). */
export const grokToolOf = (u: any): string => String(u?._meta?.["x.ai/tool"]?.name ?? u?.title ?? "")

/** Timeline name + input for a Grok tool call. */
export function timelineTool(tool: string, raw: any): { name: string; input: unknown } {
  const r = raw ?? {}
  switch (tool) {
    case "run_terminal_command":
      return { name: "Bash", input: { command: r.command, ...(r.description ? { description: r.description } : {}), ...(r.background ? { run_in_background: true } : {}) } }
    case "monitor":
      return { name: "Monitor", input: { command: r.command, description: r.description } }
    case "write":
      return { name: "Write", input: { file_path: r.file_path, content: r.content } }
    case "search_replace":
      return { name: "Edit", input: { file_path: r.file_path, old_string: r.old_string, new_string: r.new_string, ...(r.replace_all ? { replace_all: true } : {}) } }
    case "read_file":
      return { name: "Read", input: { file_path: r.target_file ?? r.file_path, ...(r.offset ? { offset: r.offset } : {}), ...(r.limit ? { limit: r.limit } : {}) } }
    case "list_dir":
      return { name: "LS", input: { path: r.target_directory } }
    case "grep":
      return { name: "Grep", input: { pattern: r.pattern, ...(r.path ? { path: r.path } : {}), ...(r.glob ? { glob: r.glob } : {}) } }
    case "todo_write":
      return { name: "TodoWrite", input: { todos: r.todos } }
    case "web_search":
      return { name: "WebSearch", input: { query: r.query } }
    case "search_tool":
      return { name: "ToolSearch", input: { query: r.query } }
    case "ask_user_question":
      return { name: "AskUserQuestion", input: { questions: r.questions } }
    case "use_tool": {
      const [server, ...rest] = String(r.tool_name ?? "").split("__")
      return rest.length ? { name: `mcp__${server}__${rest.join("__")}`, input: r.tool_input ?? {} } : { name: String(r.tool_name ?? "use_tool"), input: r.tool_input ?? {} }
    }
    default:
      return { name: tool || "tool", input: r }
  }
}

function contentText(content: any[]): { text: string; images: AgentImage[] } {
  const texts: string[] = []
  const images: AgentImage[] = []
  for (const c of content ?? []) {
    if (c?.type === "content" && c.content?.type === "text") texts.push(String(c.content.text ?? ""))
    else if (c?.type === "content" && c.content?.type === "image" && typeof c.content.data === "string") images.push({ mediaType: String(c.content.mimeType ?? "image/png"), data: c.content.data })
    else if (c?.type === "diff" && c.path) texts.push(`Updated ${c.path}`)
  }
  return { text: texts.join("\n"), images }
}

function rawText(raw: any): string {
  if (!raw || typeof raw !== "object") return raw == null ? "" : String(raw)
  if (raw.type === "MCP") {
    const o = raw.output ?? {}
    return String(o.OkayOutput ?? o.ErrorOutput ?? o.Error ?? JSON.stringify(o))
  }
  if (raw.type === "Bash") return String(raw.output_for_prompt ?? "")
  if (typeof raw.message === "string") return raw.message
  return ""
}

export class GrokNormalizer {
  private turn = "t0"
  private seg = 0
  private buf: { text: string; thinking: string } = { text: "", thinking: "" }
  /** toolCallId -> Grok tool id (updates don't always repeat it). */
  private tools = new Map<string, string>()

  get turnId() {
    return this.turn
  }

  /** A new turn (prompt): ids are scoped to it. */
  startTurn(turnId: string) {
    this.turn = turnId
    this.seg = 0
    this.buf = { text: "", thinking: "" }
  }

  private id(kind: string) {
    return `${this.turn}:${kind}:${this.seg}`
  }

  /** Close the open text/thinking blocks (before a tool call and at the turn end). */
  flush(): NormalizedOut[] {
    const out: NormalizedOut[] = []
    if (this.buf.thinking.trim()) out.push({ event: { type: "message.completed", role: "assistant", kind: "thinking", text: this.buf.thinking }, itemId: this.id("thinking") })
    if (this.buf.text.trim()) out.push({ event: { type: "message.completed", role: "assistant", kind: "text", text: this.buf.text }, itemId: this.id("text") })
    if (this.buf.text || this.buf.thinking) this.seg++
    this.buf = { text: "", thinking: "" }
    return out
  }

  convert(update: any): NormalizedOut[] {
    const u = update ?? {}
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const kind = u.sessionUpdate === "agent_message_chunk" ? "text" : "thinking"
        const delta = u.content?.type === "text" ? String(u.content.text ?? "") : ""
        if (!delta) return []
        this.buf[kind] += delta
        return [{ event: { type: "message.delta", role: "assistant", kind, delta }, itemId: this.id(kind), persist: false }]
      }
      case "tool_call": {
        const callId = String(u.toolCallId ?? "")
        const tool = grokToolOf(u)
        this.tools.set(callId, tool)
        const t = timelineTool(tool, u.rawInput)
        return [...this.flush(), { event: { type: "tool.started", name: t.name, input: t.input }, itemId: `${this.turn}:${callId}` }]
      }
      case "tool_call_update": {
        const callId = String(u.toolCallId ?? "")
        const itemId = `${this.turn}:${callId}`
        if (u.status === "completed" || u.status === "failed") {
          const c = contentText(u.content)
          const text = c.text || rawText(u.rawOutput)
          const exit = u.rawOutput?.type === "Bash" ? u.rawOutput.exit_code : null
          const isError = u.status === "failed" || (typeof exit === "number" && exit !== 0)
          return [{ event: { type: "tool.completed", isError, text, images: c.images }, itemId }]
        }
        return []
      }
      default:
        return [] // user_message_chunk (the app shows the user's bubble), plan, commands, session info
    }
  }
}
