// Codex app-server notifications -> normalized AgentEvents (shared/types.ts). Items only: the turn lifecycle,
// usage and run results are the adapter's (they need its state). Pure, so protocol fixtures can drive it directly.
//
// Item ids are scoped to their turn in the timeline (`<turnId>:<itemId>`) so ids reused across turns can't merge
// two timeline items. App tools are named like Claude's in-process MCP tools (mcp__studio__<name>), native shell
// commands "Bash", patches "Edit", so the timeline renders a Codex session the way it renders a Claude one.
import type { AgentEvent, AgentImage } from "../../../../shared/types"
import { timelineToolName } from "./tools"

export interface NormalizedOut {
  event: AgentEvent
  itemId: string | null
  persist?: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Item = { type: string; id?: string; [k: string]: any }

const scoped = (turnId: string | undefined, itemId: string | undefined) => (itemId ? (turnId ? `${turnId}:${itemId}` : itemId) : null)

/** "data:image/png;base64,AAAA" -> {mediaType, data}; other URLs stay URLs. */
export function imageFromUrl(url: string): AgentImage {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return m ? { mediaType: m[1], data: m[2] } : { mediaType: "image/*", url }
}

function toolStart(item: Item): { name: string; input: unknown } | null {
  switch (item.type) {
    case "commandExecution":
      return { name: "Bash", input: { command: item.command, ...(item.cwd ? { cwd: item.cwd } : {}) } }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : []
      return { name: "Edit", input: { file_path: changes[0]?.path ?? "", changes: changes.map((c: any) => ({ path: c.path, kind: c.kind?.type ?? c.kind, diff: c.diff })) } }
    }
    case "dynamicToolCall":
      return { name: timelineToolName(String(item.tool)), input: item.arguments ?? {} }
    case "mcpToolCall":
      return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} }
    case "webSearch":
      return { name: "WebSearch", input: { query: item.query ?? item.action?.query ?? "" } }
    case "imageView":
      return { name: "Read", input: { file_path: item.path } }
    default:
      return null
  }
}

function toolDone(item: Item): Extract<AgentEvent, { type: "tool.completed" }> | null {
  switch (item.type) {
    case "commandExecution": {
      const declined = item.status === "declined"
      const text = declined
        ? "Blocked by Crease: commands always run inside the safety sandbox (no network, project folder only)."
        : String(item.aggregatedOutput ?? "")
      return { type: "tool.completed", isError: declined || item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0), text, images: [] }
    }
    case "fileChange": {
      const paths = (Array.isArray(item.changes) ? item.changes : []).map((c: any) => c.path).join(", ")
      const ok = item.status === "completed"
      const text = ok ? `Updated ${paths}` : item.status === "declined" ? `Blocked by Crease: ${paths} can't be changed from a session.` : `Couldn't update ${paths}`
      return { type: "tool.completed", isError: !ok, text, images: [] }
    }
    case "dynamicToolCall": {
      const items = Array.isArray(item.contentItems) ? item.contentItems : []
      const text = items
        .filter((c: any) => c.type === "inputText")
        .map((c: any) => String(c.text))
        .join("\n")
      const images = items.filter((c: any) => c.type === "inputImage" && typeof c.imageUrl === "string").map((c: any) => imageFromUrl(c.imageUrl))
      return { type: "tool.completed", isError: item.success === false || item.status === "failed", text, images }
    }
    case "mcpToolCall": {
      const content = Array.isArray(item.result?.content) ? item.result.content : []
      const text = item.error?.message ?? content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text)).join("\n")
      const images = content.filter((c: any) => c?.type === "image").map((c: any) => ({ mediaType: c.mimeType, data: c.data }))
      return { type: "tool.completed", isError: !!item.error || item.status === "failed", text, images }
    }
    case "webSearch":
    case "imageView":
      return { type: "tool.completed", isError: false, text: "", images: [] }
    default:
      return null
  }
}

export class CodexNormalizer {
  /** Turn items that already got a tool.started (item/started), so completion doesn't need to re-send it. */
  private started = new Set<string>()

  convert(method: string, params: any): NormalizedOut[] {
    const p = params ?? {}
    switch (method) {
      case "item/agentMessage/delta":
        return [{ event: { type: "message.delta", role: "assistant", kind: "text", delta: String(p.delta ?? "") }, itemId: scoped(p.turnId, p.itemId), persist: false }]
      case "item/reasoning/summaryTextDelta":
        return [{ event: { type: "message.delta", role: "assistant", kind: "thinking", delta: String(p.delta ?? "") }, itemId: scoped(p.turnId, p.itemId), persist: false }]
      case "item/started": {
        const item = p.item as Item | undefined
        if (!item) return []
        const t = toolStart(item)
        if (!t) return []
        const id = scoped(p.turnId, item.id)
        if (id) this.started.add(id)
        return [{ event: { type: "tool.started", name: t.name, input: t.input }, itemId: id }]
      }
      case "item/completed": {
        const item = p.item as Item | undefined
        if (!item) return []
        const id = scoped(p.turnId, item.id)
        if (item.type === "agentMessage") {
          const text = String(item.text ?? "")
          return text ? [{ event: { type: "message.completed", role: "assistant", kind: "text", text }, itemId: id }] : []
        }
        if (item.type === "reasoning") {
          const text = (Array.isArray(item.summary) ? item.summary : []).map(String).join("\n\n").trim()
          return text ? [{ event: { type: "message.completed", role: "assistant", kind: "thinking", text }, itemId: id }] : []
        }
        if (item.type === "contextCompaction") return [{ event: { type: "notice", level: "info", text: "Context compacted" }, itemId: id }]
        const done = toolDone(item)
        if (!done) return []
        const out: NormalizedOut[] = []
        // The full call (final input, e.g. a command's resolved cwd) upserts the row started on item/started.
        const t = toolStart(item)
        if (t && id && !this.started.has(id)) out.push({ event: { type: "tool.started", name: t.name, input: t.input }, itemId: id })
        if (id) this.started.delete(id)
        out.push({ event: done, itemId: id })
        return out
      }
      case "model/rerouted":
        return [{ event: { type: "notice", level: "info", text: `Codex switched model: ${p.fromModel} → ${p.toModel}` }, itemId: `reroute:${p.turnId ?? ""}` }]
      default:
        return []
    }
  }
}
