// Session transcripts on disk.
//
//   .studio/sessions/<sessionId>.jsonl          normalized AgentEventEnvelope lines (what the timeline replays)
//   .studio/sessions/native/<sessionId>.jsonl   redacted native runtime messages in AgentEnvelope lines, plus the
//                                               app's user_input / app_notice / app_error (diagnostics, evals)
//
// Before R11a the first file held AgentEnvelope lines with raw Claude SDK messages. Those are migrated on read
// (never rewritten): a file may hold legacy lines followed by normalized ones (an old session resumed).
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEnvelope, type AgentEvent, type AgentEventEnvelope } from "../../shared/types"
import { deps } from "./deps"
import { ClaudeNormalizer, contentToText } from "./runtime/claude/normalize"

export const sessionsDir = (projectId: string) => join(deps.projectDir(projectId), ".studio", "sessions")
export const eventsPath = (projectId: string, sessionId: string) => join(sessionsDir(projectId), `${sessionId}.jsonl`)
export const nativePath = (projectId: string, sessionId: string) => join(sessionsDir(projectId), "native", `${sessionId}.jsonl`)

function readLines(file: string): unknown[] {
  if (!existsSync(file)) return []
  const out: unknown[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* skip torn line */
    }
  }
  return out
}

export const isEventEnvelope = (x: unknown): x is AgentEventEnvelope =>
  !!x && typeof x === "object" && (x as { schemaVersion?: unknown }).schemaVersion === AGENT_EVENT_SCHEMA_VERSION && "event" in x

/**
 * Legacy transcript lines (raw Claude SDK messages + the app's user_input / app_notice / app_error) -> normalized
 * events. Stateful across one file, like the old timeline reducer. Runs get a synthetic id from the user_input line.
 */
export class LegacyMigrator {
  private norm = new ClaudeNormalizer()
  private runId: string | null = null

  migrate(env: AgentEnvelope): AgentEventEnvelope[] {
    const m = env.message
    const events: { event: AgentEvent; itemId: string | null }[] = []
    const base = `l${env.seq}`
    if (m && typeof m === "object" && m.type === "user_input") {
      this.runId = `legacy-${env.seq}`
      const text = String(m.text ?? "")
      this.norm.userInput(text)
      events.push({
        event: {
          type: "run.started",
          input: {
            text,
            ...(Array.isArray(m.images) && m.images.length ? { images: m.images.filter((i: { data?: unknown }) => i && typeof i.data === "string") } : {}),
            ...(Array.isArray(m.annotations) && m.annotations.length
              ? { annotations: m.annotations.filter((a: { n?: unknown }) => a && typeof a.n === "number") }
              : {}),
          },
        },
        itemId: `user:${this.runId}`,
      })
    } else if (m && typeof m === "object" && m.type === "app_notice") {
      events.push({ event: { type: "notice", level: "info", text: String(m.text ?? "notice") }, itemId: base })
    } else if (m && typeof m === "object" && m.type === "app_error") {
      events.push({ event: { type: "notice", level: "error", text: contentToText(m.error ?? m.message ?? m), ...(typeof m.code === "string" ? { code: m.code } : {}) }, itemId: base })
    } else {
      // Stream frames were never persisted, so everything here is complete: keep persisted events only.
      for (const e of this.norm.convert(m, base, { billing: "unknown" })) if (e.persist) events.push(e)
    }
    const runId = this.runId
    const out = events.map(({ event, itemId }, k) => ({
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
      eventId: k === 0 ? String(env.seq) : `${env.seq}.${k}`,
      seq: env.seq,
      ts: env.ts ?? "",
      projectId: env.projectId,
      sessionId: env.sessionId,
      runId,
      itemId,
      revision: null,
      runtime: "claude",
      event,
    }))
    if (events.some((e) => e.event.type === "run.completed" || e.event.type === "run.failed" || e.event.type === "run.interrupted")) this.runId = null
    return out
  }
}

/** The session's events, legacy lines migrated. */
export function readEvents(projectId: string, sessionId: string): AgentEventEnvelope[] {
  const out: AgentEventEnvelope[] = []
  let migrator: LegacyMigrator | null = null
  for (const line of readLines(eventsPath(projectId, sessionId))) {
    if (isEventEnvelope(line)) out.push(line)
    else if (line && typeof line === "object" && "message" in line) out.push(...(migrator ??= new LegacyMigrator()).migrate(line as AgentEnvelope))
  }
  return out
}

/** Next free seq for a session (over both formats). */
export function nextSeq(projectId: string, sessionId: string): number {
  let max = -1
  for (const line of readLines(eventsPath(projectId, sessionId))) {
    const s = (line as { seq?: unknown })?.seq
    if (typeof s === "number" && s > max) max = s
  }
  return max + 1
}

/** Append one JSON line; a torn last line (crash mid-write) is closed first so it can't swallow this one. */
function appendLine(f: string, line: string) {
  mkdirSync(join(f, ".."), { recursive: true })
  let sep = ""
  if (existsSync(f)) {
    const fd = openSync(f, "r")
    try {
      const size = fstatSync(fd).size
      if (size > 0) {
        const b = Buffer.alloc(1)
        readSync(fd, b, 0, 1, size - 1)
        if (b[0] !== 0x0a) sep = "\n"
      }
    } finally {
      closeSync(fd)
    }
  }
  appendFileSync(f, sep + line + "\n")
}

export function appendEvent(env: AgentEventEnvelope) {
  appendLine(eventsPath(env.projectId, env.sessionId), JSON.stringify(env))
}

export function writeEvents(projectId: string, sessionId: string, envs: AgentEventEnvelope[]) {
  const f = eventsPath(projectId, sessionId)
  mkdirSync(join(f, ".."), { recursive: true })
  writeFileSync(f, envs.map((e) => JSON.stringify(e)).join("\n") + (envs.length ? "\n" : ""))
}

/** Big base64 payloads (images) aren't worth keeping twice: the normalized transcript has them. */
function stripImages(v: unknown, depth = 0): unknown {
  if (depth > 12) return v
  if (typeof v === "string") return v.length > 2048 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 2048)) ? `[base64 omitted, ${v.length} chars]` : v
  if (Array.isArray(v)) return v.map((x) => stripImages(x, depth + 1))
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripImages(x, depth + 1)]))
  return v
}

export function appendNative(env: AgentEnvelope) {
  appendLine(nativePath(env.projectId, env.sessionId), JSON.stringify({ ...env, message: stripImages(env.message) }))
}

/** Native/legacy view of a session (GET …/agent/timeline): legacy lines of the main file, then the native log. */
export function readNative(projectId: string, sessionId: string): AgentEnvelope[] {
  const legacy = readLines(eventsPath(projectId, sessionId)).filter(
    (l): l is AgentEnvelope => !isEventEnvelope(l) && !!l && typeof l === "object" && "message" in l
  )
  return [...legacy, ...(readLines(nativePath(projectId, sessionId)) as AgentEnvelope[])]
}

/** Copy a session's native log under a new session id (fork). */
export function copyNative(projectId: string, from: string, to: string) {
  const envs = readNative(projectId, from).map((e) => ({ ...e, sessionId: to }))
  if (!envs.length) return
  const f = nativePath(projectId, to)
  mkdirSync(join(f, ".."), { recursive: true })
  writeFileSync(f, envs.map((e) => JSON.stringify(e)).join("\n") + "\n")
}

/**
 * Cumulative session cost from the transcript: the largest reconciled figure (billed if known, else the API
 * estimate). Legacy results carry studio_cost_usd / total_cost_usd, migrated into usage.
 */
export function sessionCostFrom(envs: AgentEventEnvelope[]): number {
  let cost = 0
  for (const e of envs) {
    const ev = e.event
    const usage =
      ev.type === "usage.updated"
        ? ev.usage
        : ev.type === "run.completed" || ev.type === "run.failed" || ev.type === "run.interrupted"
          ? ev.result?.usage
          : null
    if (!usage || !usage.final) continue
    const v = usage.billedUsd ?? usage.estimatedApiUsd
    if (typeof v === "number" && isFinite(v)) cost = Math.max(cost, v)
  }
  return cost
}

// ---- App session id -> runtime + native session id (R11d) ----
// Claude takes the app's id (native == app). Runtimes that choose their own ids (Codex threads) are mapped here, so the
// app's session id (transcripts, project.json, catalog) stays stable and resume/fork use the native one.
// <project>/.studio/sessions/native-refs.json: {[appSessionId]: {runtime, nativeId}}. App-owned: the agent can't write .studio/.
export interface NativeRef {
  runtime: string
  nativeId: string
}
export const nativeRefsPath = (projectId: string) => join(sessionsDir(projectId), "native-refs.json")

function readRefs(projectId: string): Record<string, NativeRef> {
  try {
    const v = JSON.parse(readFileSync(nativeRefsPath(projectId), "utf8")) as unknown
    return v && typeof v === "object" ? (v as Record<string, NativeRef>) : {}
  } catch {
    return {}
  }
}

/** The runtime and native id recorded for an app session; null for sessions from before R11d (Claude: native == app). */
export function nativeRef(projectId: string, sessionId: string): NativeRef | null {
  const r = readRefs(projectId)[sessionId]
  return r && typeof r.runtime === "string" && typeof r.nativeId === "string" ? r : null
}

export function setNativeRef(projectId: string, sessionId: string, ref: NativeRef) {
  const refs = readRefs(projectId)
  const cur = refs[sessionId]
  if (cur && cur.runtime === ref.runtime && cur.nativeId === ref.nativeId) return
  refs[sessionId] = ref
  mkdirSync(sessionsDir(projectId), { recursive: true })
  writeFileSync(nativeRefsPath(projectId), JSON.stringify(refs, null, 2) + "\n")
}
