// R11g: portable handoff between designers (runtimes), and "fresh chat with a summary" within one.
//
// Native conversation resume stays inside its runtime. Moving to another runtime starts a NEW app session whose first
// message carries a summary the APP writes from the project's records (never the model): what the user asked for and
// answered, the design now, approval, decisions shown, checks, supplies, prints, references and the last few messages.
// The user sees it (and can edit it) before the switch. Stored as .studio/handoffs/<id>.json + <id>.md; the session it
// is waiting for is in .studio/handoffs/pending.json until it's delivered with the next message.
//
// This file: the pure parts (transcript facts, markdown, redaction) and storage. Collecting the project state lives
// in handoff-collect.ts (it reaches into overview/checks/prints), injected into the coordinator.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  AGENT_MODELS,
  type AgentEventEnvelope,
  type AgentProfileSnapshot,
  type HandoffDesigner,
  type HandoffReason,
  type HandoffRecord,
  type HandoffSummary,
} from "../../shared/types"
import { STUDIO_HOME } from "../config"
import { redactSecrets } from "../secrets"
import { deps } from "./deps"

// ---------------------------------------------------------------------------------------------
// Designers
// ---------------------------------------------------------------------------------------------

const RUNTIME_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", api: "API connection" }
export const runtimeLabel = (r: string) => RUNTIME_LABEL[r] ?? r

const modelLabel = (m: string) => AGENT_MODELS.find((x) => x.value === m)?.label ?? m

/** "Claude (Opus)": the profile's name and its model, for people. */
export function designerLabel(name: string, model: string | null): string {
  if (!model) return name
  const label = modelLabel(model)
  return name.toLowerCase().includes(label.toLowerCase()) ? name : `${name} (${label})`
}

export function designerOf(p: Pick<AgentProfileSnapshot, "profileId" | "name" | "runtime" | "model">): HandoffDesigner {
  return { profileId: p.profileId, name: designerLabel(p.name, p.model), runtime: p.runtime, model: p.model }
}

/** Who held a session, from its own transcript (the last run's frozen profile); null = never ran. */
export function designerFromEvents(events: AgentEventEnvelope[], fallbackRuntime: string): HandoffDesigner | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i].event
    if (ev.type !== "run.started") continue
    const runtime = ev.profile?.runtime ?? (events.find((e) => e.runtime !== "app")?.runtime || fallbackRuntime)
    const name = ev.profile?.name ?? runtimeLabel(runtime)
    return { profileId: ev.profile?.id ?? null, name: designerLabel(name, ev.model ?? null), runtime, model: ev.model ?? null }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Transcript facts (pure)
// ---------------------------------------------------------------------------------------------

export interface TranscriptFacts {
  firstAsk: string | null
  asks: string[]
  answers: { question: string; answer: string }[]
  plans: { title: string | null; bullets: string[] }[]
  pins: string[]
  recent: { role: "user" | "assistant"; text: string }[]
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
export const trimText = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s)
const ASK_TOOL = /(^|__)(AskUserQuestion|ask_user_question)$/i
const PLAN_TOOL = /(^|__)share_plan$/

/** The user's requests, answers, plan cards, pins and the last few messages of one session's normalized events. */
export function transcriptFacts(events: AgentEventEnvelope[], opts: { recent?: number; recentChars?: number } = {}): TranscriptFacts {
  const asks: string[] = []
  const answers: { question: string; answer: string }[] = []
  const plans: { title: string | null; bullets: string[] }[] = []
  const pins: string[] = []
  const messages: { role: "user" | "assistant"; text: string; key: string }[] = []
  const askInputs = new Map<string, string[]>() // tool call id -> questions
  const done = new Set<string>()
  for (const e of events) {
    const ev = e.event
    if (ev.type === "run.started") {
      const text = (ev.input?.text ?? "").trim()
      if (text) {
        asks.push(text)
        messages.push({ role: "user", text, key: `u:${e.eventId}` })
      }
      for (const a of ev.input?.annotations ?? []) pins.push(oneLine(`Pin ${a.n}${a.partId ? ` on ${a.partId}` : ""}${a.hint ? ` (${a.hint})` : ""}: ${a.note || "(no note)"}`))
    } else if (ev.type === "message.completed" && ev.role === "assistant" && ev.kind === "text" && !ev.parentToolId && ev.text.trim()) {
      // a block is upserted by its item: keep the newest text per item
      const key = `a:${e.itemId ?? e.eventId}`
      const at = messages.findIndex((m) => m.key === key)
      if (at >= 0) messages.splice(at, 1)
      messages.push({ role: "assistant", text: ev.text.trim(), key })
    } else if (ev.type === "tool.started" && e.itemId) {
      if (ASK_TOOL.test(ev.name)) {
        const qs = (ev.input as { questions?: { question?: unknown }[] } | undefined)?.questions
        if (Array.isArray(qs)) askInputs.set(e.itemId, qs.map((q) => String(q?.question ?? "")).filter(Boolean))
      } else if (PLAN_TOOL.test(ev.name) && ev.input && typeof ev.input === "object" && !done.has(`plan:${e.itemId}`)) {
        const inp = ev.input as { title?: unknown; bullets?: unknown }
        const bullets = Array.isArray(inp.bullets) ? inp.bullets.filter((b): b is string => typeof b === "string" && !!b.trim()) : []
        if (bullets.length) {
          done.add(`plan:${e.itemId}`)
          plans.push({ title: typeof inp.title === "string" && inp.title.trim() ? inp.title.trim() : null, bullets })
        }
      }
    } else if (ev.type === "tool.completed" && e.itemId && askInputs.has(e.itemId) && !ev.isError && !done.has(`ans:${e.itemId}`)) {
      done.add(`ans:${e.itemId}`)
      // Claude's AskUserQuestion wording, which every runtime's ask tool reuses: "q"="a", "q2"="a2"
      for (const m of ev.text.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) {
        const question = m[1].trim()
        const answer = m[2].replace(/\s*\(recommended\)/gi, "").trim()
        if (question && answer) {
          const prev = answers.findIndex((x) => x.question === question)
          if (prev >= 0) answers.splice(prev, 1)
          answers.push({ question, answer })
        }
      }
    }
  }
  const n = opts.recent ?? 6
  const chars = opts.recentChars ?? 700
  return {
    firstAsk: asks[0] ?? null,
    asks: asks.slice(1),
    answers,
    plans,
    pins,
    recent: messages.slice(-n).map(({ role, text }) => ({ role, text: trimText(text, chars) })),
  }
}

// ---------------------------------------------------------------------------------------------
// Redaction: no secrets, no absolute paths
// ---------------------------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const ABS_PATH = /(^|[\s"'`(=:,[])(\/(?:Users|home|private|var|tmp|opt|Applications|Volumes|etc|usr|root|mnt|srv)\/[^\s"'`)\],]*)/g
const WIN_PATH = /\b[A-Za-z]:\\[^\s"'`)\],]*/g

/** Secrets out (known key values + key patterns), the project folder made relative, every other absolute path hidden. */
export function scrubText(text: string, projectRoot: string | null): string {
  // known values + Anthropic keys (secrets.ts), and other providers' key shapes the app may hold (OpenAI, xAI)
  let out = redactSecrets(text).replace(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,})/g, "[redacted]")
  const roots = [projectRoot, STUDIO_HOME, homedir()].filter((r): r is string => !!r && r.length > 1)
  for (const r of roots) {
    const re = new RegExp(escapeRe(r.replace(/\/+$/, "")) + "(/|\\b)", "g")
    out = out.replace(re, (_m, slash: string) => (r === projectRoot ? (slash ? "" : ".") : r === STUDIO_HOME ? "<Crease data>" + slash : "~" + slash))
  }
  out = out.replace(ABS_PATH, (_m, pre: string) => `${pre}<path>`)
  out = out.replace(WIN_PATH, "<path>")
  return out
}

/** scrubText over every string of a JSON value. */
export function scrubDeep<T>(value: T, projectRoot: string | null): T {
  return JSON.parse(JSON.stringify(value), (_k, v) => (typeof v === "string" ? scrubText(v, projectRoot) : v)) as T
}

// ---------------------------------------------------------------------------------------------
// Markdown (pure): what the new designer is told; the user reads it first
// ---------------------------------------------------------------------------------------------

const mm = (v: [number, number, number]) => `${v.map((x) => Math.round(x * 10) / 10).join(" × ")} mm`
const inch = (v: [number, number, number]) => `${v.map((x) => Math.round((x / 25.4) * 100) / 100).join(" × ")} in`
const quote = (s: string) => `“${s}”`

export function handoffMarkdown(s: HandoffSummary, from: HandoffDesigner | null, reason: HandoffReason): string {
  const L: string[] = []
  L.push(`# Handoff: ${s.project.name}`)
  L.push("")
  const who = from ? `${from.name}` : "an earlier chat"
  L.push(
    reason === "fresh"
      ? `This is a fresh chat about this project. Crease wrote this summary of the earlier chat (with ${who}) from the project's records.`
      : reason === "resume"
        ? `You worked on this project earlier in this chat. Since then another designer (${who}) worked on it. Crease wrote this summary of where things stand now from the project's records.`
        : `You're taking over this project from another designer (${who}). Crease wrote this summary from the project's records; it is not that designer's own notes, and you can't see the earlier conversation.`,
  )
  L.push("The files in this folder are the source of truth: read them before changing anything.")
  if (s.project.description) L.push("", `About it: ${s.project.description}`)

  L.push("", "## What the user asked for")
  if (s.requirements.firstAsk) L.push(`- First request: ${quote(trimText(oneLine(s.requirements.firstAsk), 600))}`)
  if (s.requirements.answers.length) {
    L.push("- Their answers to your questions:")
    for (const a of s.requirements.answers) L.push(`  - ${a.question} → ${a.answer}`)
  }
  if (s.requirements.asks.length) {
    L.push("- Later requests (oldest first):")
    for (const a of s.requirements.asks) L.push(`  - ${quote(trimText(oneLine(a), 300))}`)
  }
  if (!s.requirements.firstAsk && !s.requirements.answers.length && !s.requirements.asks.length) L.push("- Nothing recorded yet.")

  L.push("", "## The design now")
  const d = s.design
  const where = [d.idea ? `Idea: ${d.idea}` : null, d.version ? `latest saved version ${d.version.short} ${quote(d.version.message)}` : null].filter(Boolean)
  if (where.length) L.push(`- ${where.join(" · ")}`)
  if (d.size) L.push(`- Overall size: ${mm(d.size.mm)} (${inch(d.size.mm)}; ${d.size.basis})`)
  if (d.parts.length) {
    L.push("- Parts:")
    for (const p of d.parts)
      L.push(
        `  - ${p.name}${p.name !== p.id ? ` (${p.id})` : ""} × ${p.qty}${p.sizeMm ? ` — ${mm(p.sizeMm)}` : ""}${p.colors.length ? ` — ${p.colors.join(", ")}` : ""}${p.error ? ` — doesn't build: ${p.error}` : ""}`,
      )
  } else L.push("- No parts designed yet.")
  L.push(
    s.approved
      ? "- Approval: the user approved this exact design for printing."
      : "- Approval: not approved yet. Show it and ask “How does this look?” before slicing or asking to print.",
  )

  if (s.decisions.length) {
    L.push("", "## Decisions shown to the user (plan cards)")
    for (const p of s.decisions) {
      if (p.title) L.push(`- ${p.title}:`)
      for (const b of p.bullets) L.push(`${p.title ? "  " : ""}- ${b}`)
    }
  }

  L.push("", "## Checks")
  const c = s.checks
  if (!c.failing.length && !c.outOfDate.length && !c.motion && !c.open.length) L.push("- Nothing failing or out of date.")
  for (const f of c.failing) L.push(`- Failing: ${f}`)
  for (const o of c.outOfDate) L.push(`- Out of date: ${o}`)
  if (c.motion) L.push(`- Motion check: ${c.motion}`)
  for (const o of c.open) L.push(`- Still open: ${o}`)

  if (s.supplies?.length) {
    L.push("", "## Things to buy")
    for (const i of s.supplies) L.push(`- ${i.name}${i.need ? `: ${i.need}` : ""}`)
  }

  L.push("", "## Prints so far")
  if (!s.prints.last && !s.prints.outcomes.length) L.push("- Not printed yet.")
  if (s.prints.last) L.push(`- ${s.prints.last}`)
  for (const o of s.prints.outcomes) L.push(o.startsWith("- ") ? o : `- ${o}`)

  if (s.references.files.length || s.references.pins.length) {
    L.push("", "## References")
    if (s.references.files.length) L.push(`- Files the user gave (refs/): ${s.references.files.join(", ")}`)
    for (const p of s.references.pins) L.push(`- ${p}`)
  }

  if (s.recent.length) {
    L.push("", "## Last messages (word for word, shortened)")
    for (const m of s.recent) L.push(`**${m.role === "user" ? "User" : "Designer"}:** ${m.text.replace(/\n{2,}/g, "\n")}`, "")
    while (L[L.length - 1] === "") L.pop()
  }
  return L.join("\n") + "\n"
}

/** What the designer gets as the start of the new chat's first message (the user's bubble shows only their text). */
export function handoffMessage(rec: Pick<HandoffRecord, "markdown" | "mode">, userText: string): string {
  const head =
    rec.mode === "resume"
      ? "[Crease: what changed while you were away. The user saw this summary before coming back to you. Read it, then answer their message below.]"
      : "[Crease handoff: this chat starts from a summary of the project so far. The user saw it before the chat started. Read it, then answer their message below.]"
  return `${head}\n\n${rec.markdown.trim()}\n\n[End of the summary. The user's message:]\n${userText}`
}

// ---------------------------------------------------------------------------------------------
// Storage: .studio/handoffs/<id>.json + <id>.md, pending.json {sessionId: handoffId}
// ---------------------------------------------------------------------------------------------

export const handoffsDir = (projectId: string) => join(deps.projectDir(projectId), ".studio", "handoffs")
const pendingFile = (projectId: string) => join(handoffsDir(projectId), "pending.json")
const SAFE_ID = /^[\w-]{1,80}$/

function writeAtomic(file: string, text: string) {
  writeFileSync(file + ".tmp", text)
  renameSync(file + ".tmp", file)
}

export function saveHandoff(projectId: string, rec: HandoffRecord) {
  if (!SAFE_ID.test(rec.id)) throw new Error("bad handoff id")
  const dir = handoffsDir(projectId)
  mkdirSync(dir, { recursive: true })
  writeAtomic(join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2) + "\n")
  writeAtomic(join(dir, `${rec.id}.md`), rec.markdown)
}

export function readHandoff(projectId: string, id: string): HandoffRecord | null {
  if (!SAFE_ID.test(id)) return null
  try {
    return JSON.parse(readFileSync(join(handoffsDir(projectId), `${id}.json`), "utf8")) as HandoffRecord
  } catch {
    return null
  }
}

/** The newest handoff into a session (a chat started from one, or caught up by one on a resume); null = none. */
export function latestHandoffInto(projectId: string, sessionId: string): HandoffRecord | null {
  let best: HandoffRecord | null = null
  let names: string[]
  try {
    names = readdirSync(handoffsDir(projectId)).filter((n) => n.endsWith(".json") && n !== "pending.json")
  } catch {
    return null
  }
  for (const n of names) {
    const r = readHandoff(projectId, n.slice(0, -5))
    if (r?.toSessionId === sessionId && (!best || r.createdAt > best.createdAt)) best = r
  }
  return best
}

function readPending(projectId: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(pendingFile(projectId), "utf8")) as Record<string, string>
  } catch {
    return {}
  }
}

export function setPending(projectId: string, sessionId: string, handoffId: string | null) {
  const p = readPending(projectId)
  if (handoffId) p[sessionId] = handoffId
  else delete p[sessionId]
  mkdirSync(handoffsDir(projectId), { recursive: true })
  writeAtomic(pendingFile(projectId), JSON.stringify(p, null, 2) + "\n")
}

/** The handoff a session is waiting to deliver with its next message (null = none). */
export function pendingHandoff(projectId: string, sessionId: string): HandoffRecord | null {
  if (!existsSync(pendingFile(projectId))) return null
  const id = readPending(projectId)[sessionId]
  const rec = id ? readHandoff(projectId, id) : null
  return rec && !rec.deliveredAt ? rec : null
}

export function markDelivered(projectId: string, rec: HandoffRecord) {
  saveHandoff(projectId, { ...rec, deliveredAt: new Date().toISOString() })
  setPending(projectId, rec.toSessionId, null)
}
