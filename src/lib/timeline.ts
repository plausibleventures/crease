// Incremental reducer: normalized agent events (AgentEventEnvelope, shared/types.ts) -> renderable timeline items.
// Runtime-neutral: the server turns each runtime's native messages into these events, and migrates legacy
// transcripts (raw Claude SDK messages) on read, so old and new sessions render through this one reducer.
// Idempotent: events are deduped by id, and items are upserted by their stable item id.
// Relative (not @shared) so the server-side parity test (server/agent/timeline-legacy.test.ts) can import it too.
import type { AgentEventEnvelope, AgentRunResult, PointAnnotation } from "../../shared/types"

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ToolImage = { mediaType: string; data?: string; url?: string }

export type TimelineItem =
  | {
      kind: "user"
      key: string
      text: string
      ts: string
      images?: ToolImage[]
      annotations?: PointAnnotation[]
      /** Sent while the designer was busy: "waiting" until it reads it, "dropped" if Stop came first. */
      delivery?: "waiting" | "dropped"
    }
  | { kind: "text"; key: string; text: string; streaming: boolean; ts: string; sub: boolean }
  | { kind: "thinking"; key: string; text: string; streaming: boolean; ts: string }
  | {
      kind: "tool"
      key: string
      id: string
      name: string
      input: unknown
      partialInput: string
      status: "running" | "done" | "error"
      startedAt: string
      endedAt: string | null
      resultText: string
      images: ToolImage[]
      sub: boolean
    }
  | {
      kind: "result"
      key: string
      ts: string
      subtype: string
      isError: boolean
      costUsd: number | null
      durationMs: number | null
      turns: number | null
      text: string
    }
  | { kind: "error"; key: string; ts: string; text: string; code?: string }
  | { kind: "system"; key: string; ts: string; label: string; detail?: unknown }
  /** R11g: this chat started from (or was caught up with) the app's handoff summary. */
  | { kind: "handoff"; key: string; ts: string; label: string; handoffId: string; mode: "new" | "resume"; reason: string }
  | { kind: "raw"; key: string; ts: string; json: unknown }

export interface TimelineState {
  items: TimelineItem[]
  seen: Set<string>
  byKey: Map<string, number> // item key -> index
  sessionId: string | null
  lastSeqKey: string | null
  /** project folder (from the session-started notice's cwd): display paths relative to it */
  root: string | null
}

export function emptyTimeline(): TimelineState {
  return { items: [], seen: new Set(), byKey: new Map(), sessionId: null, lastSeqKey: null, root: null }
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Display helper: make absolute paths project-relative ("/…/projects/tray/parts/a.scad" → "parts/a.scad") and hide
 * the home folder ("/Users/name/…" → "~/…"), so the timeline doesn't leak usernames or scratch dirs.
 * Raw JSON views keep the original.
 */
export function relPaths(text: string, root: string | null): string {
  if (!text) return text
  let out = text
  if (root) {
    const r = root.replace(/\/+$/, "")
    // macOS: /tmp ⇄ /private/tmp, /var ⇄ /private/var
    const variants = new Set([r, r.replace(/^\/private(?=\/(tmp|var)\/)/, ""), r.startsWith("/tmp/") || r.startsWith("/var/") ? "/private" + r : r])
    for (const v of variants) {
      out = out.replace(new RegExp(escapeRe(v) + "/", "g"), "").replace(new RegExp(escapeRe(v) + "(?![\\w.-])", "g"), ".")
    }
  }
  return out.replace(/(^|[\s"'(=:])\/(?:Users|home)\/[^/\s"']+/g, "$1~")
}

/** relPaths over every string inside a JSON-ish value. */
export function relPathsDeep<T>(v: T, root: string | null): T {
  if (typeof v === "string") return relPaths(v, root) as T
  if (Array.isArray(v)) return v.map((x) => relPathsDeep(x, root)) as T
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relPathsDeep(x, root)])) as T
  return v
}

function push(s: TimelineState, item: TimelineItem) {
  s.byKey.set(item.key, s.items.length)
  s.items.push(item)
}

function update(s: TimelineState, key: string, fn: (it: any) => any) {
  const idx = s.byKey.get(key)
  if (idx === undefined) return false
  s.items[idx] = fn(s.items[idx])
  return true
}

function resultItem(key: string, ts: string, r: AgentRunResult): TimelineItem {
  const u = r.usage
  return {
    kind: "result",
    key,
    ts,
    subtype: r.subtype,
    isError: r.isError,
    // The session's cumulative cost: billed when known, else the API-equivalent estimate (Cost labels which).
    costUsd: u ? (u.billedUsd ?? u.estimatedApiUsd ?? null) : null,
    durationMs: r.durationMs,
    turns: r.turns,
    text: r.text,
  }
}

/** Apply one event; returns a new state (shallow-cloned items), or the same state for an event already seen. */
export function applyEvent(prev: TimelineState, env: AgentEventEnvelope): TimelineState {
  const seqKey = `${env.sessionId}:${env.eventId ?? env.seq}`
  if (prev.seen.has(seqKey)) return prev
  const s: TimelineState = { ...prev, items: prev.items.slice() }
  s.seen.add(seqKey)
  s.lastSeqKey = seqKey
  if (env.sessionId) s.sessionId = env.sessionId
  const ts = env.ts || new Date().toISOString()
  const ev = env.event
  const key = env.itemId ?? seqKey

  try {
    if (!ev || typeof ev !== "object") {
      push(s, { kind: "raw", key, ts, json: ev })
      return s
    }
    switch (ev.type) {
      case "run.started": {
        const i = ev.input ?? { text: "" }
        const images: ToolImage[] = Array.isArray(i.images) ? i.images.filter((x) => x && typeof x.data === "string").map((x) => ({ mediaType: String(x.mediaType ?? "image/png"), data: x.data })) : []
        const annotations = Array.isArray(i.annotations) ? i.annotations.filter((a) => a && typeof a.n === "number") : []
        if (!s.byKey.has(key))
          push(s, {
            kind: "user",
            key,
            text: String(i.text ?? ""),
            ts,
            ...(images.length ? { images } : {}),
            ...(annotations.length ? { annotations } : {}),
            ...(ev.queued ? { delivery: "waiting" as const } : {}),
          })
        return s
      }
      case "input.status": {
        // The bubble of the same run (user:<runId>): received = a normal bubble.
        if (env.runId) update(s, `user:${env.runId}`, (it) => ({ ...it, delivery: ev.status === "dropped" ? "dropped" : undefined }))
        return s
      }
      case "message.delta": {
        if (!update(s, key, (it) => ({ ...it, text: it.text + (ev.delta ?? "") })))
          push(s, ev.kind === "thinking" ? { kind: "thinking", key, text: ev.delta ?? "", streaming: true, ts } : { kind: "text", key, text: ev.delta ?? "", streaming: true, ts, sub: !!ev.parentToolId })
        return s
      }
      case "message.completed": {
        if (ev.role === "user") {
          if (!s.byKey.has(key)) push(s, { kind: "user", key, text: ev.text, ts })
          return s
        }
        if (update(s, key, (it) => ({ ...it, text: ev.text || it.text, streaming: false }))) return s
        if (!ev.text.trim()) return s
        push(s, ev.kind === "thinking" ? { kind: "thinking", key, text: ev.text, streaming: false, ts } : { kind: "text", key, text: ev.text, streaming: false, ts, sub: !!ev.parentToolId })
        return s
      }
      case "tool.started": {
        const ok = update(s, key, (it) => ({
          ...it,
          input: ev.input ?? it.input,
          name: ev.name ?? it.name,
          partialInput: it.partialInput + (ev.inputDelta ?? ""),
        }))
        if (!ok)
          push(s, {
            kind: "tool",
            key,
            id: env.itemId ?? key,
            name: ev.name ?? "tool",
            input: ev.input,
            partialInput: ev.inputDelta ?? "",
            status: "running",
            startedAt: ts,
            endedAt: null,
            resultText: "",
            images: [],
            sub: !!ev.parentToolId,
          })
        return s
      }
      case "tool.completed": {
        const status = ev.isError ? "error" : "done"
        const images = Array.isArray(ev.images) ? ev.images : []
        if (!update(s, key, (it) => ({ ...it, status, endedAt: ts, resultText: ev.text, images })))
          push(s, {
            kind: "tool",
            key,
            id: env.itemId ?? key,
            name: "tool result",
            input: undefined,
            partialInput: "",
            status,
            startedAt: ts,
            endedAt: ts,
            resultText: ev.text,
            images,
            sub: false,
          })
        return s
      }
      case "run.completed":
      case "run.failed":
      case "run.interrupted": {
        const result = ev.result
        if (!result) {
          if (ev.type === "run.failed") push(s, { kind: "error", key, ts, text: ev.error })
          return s
        }
        push(s, resultItem(key, ts, result))
        // any still-running tools are finished at this point
        for (let i = 0; i < s.items.length; i++) {
          const it = s.items[i]
          if (it.kind === "tool" && it.status === "running") s.items[i] = { ...it, status: "done", endedAt: it.endedAt ?? ts }
          if ((it.kind === "text" || it.kind === "thinking") && it.streaming) s.items[i] = { ...it, streaming: false }
        }
        return s
      }
      case "notice": {
        if (ev.code === "session.started") {
          const cwd = ev.data?.cwd
          if (typeof cwd === "string" && cwd) s.root = cwd
          // Shown once per timeline (a resumed session starts again).
          if (!s.items.some((it) => it.kind === "system" && it.label.startsWith("Session started"))) push(s, { kind: "system", key, ts, label: ev.text, detail: ev })
          return s
        }
        if (ev.code === "handoff.started" && typeof ev.data?.handoffId === "string") {
          push(s, { kind: "handoff", key, ts, label: ev.text, handoffId: ev.data.handoffId, mode: ev.data.mode === "resume" ? "resume" : "new", reason: String(ev.data.reason ?? "switch") })
          return s
        }
        if (ev.level === "error") push(s, { kind: "error", key, ts, text: ev.text, ...(ev.code ? { code: ev.code } : {}) })
        else push(s, { kind: "system", key, ts, label: ev.text || "notice", detail: ev })
        return s
      }
      case "native":
        push(s, { kind: "raw", key, ts, json: ev.message })
        return s
      case "question.requested": // the dialog shows it; the AskUserQuestion tool row records it
      case "permission.requested":
      case "artifact.changed":
      case "usage.updated":
        return s
      default:
        push(s, { kind: "raw", key, ts, json: ev })
        return s
    }
  } catch (e) {
    push(s, { kind: "raw", key: key + ":err", ts, json: { reducerError: String(e), event: ev } })
    return s
  }
}
