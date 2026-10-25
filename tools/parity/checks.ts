// Objective checks on a designer session, read from its normalized events (GET …/agent/events: the same stream the
// timeline renders, whatever the runtime). Pure, so tools/parity/checks.test.ts can feed it synthetic sessions.
import type { AgentEventEnvelope, AgentEvent } from "../../shared/types"

type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>

export const REVIEW_Q = /how (does|do) (?!you\b)[\w ,'’-]{1,60}? looks?\b|ready to print|look(s)? (right|good) to you|happy with (this|it|how)/i
const RUN_END = new Set(["run.completed", "run.failed", "run.interrupted"])

/** App tool name without the timeline prefix (mcp__studio__render_part -> render_part). */
export const toolName = (n: string) => n.replace(/^mcp__studio__/, "").replace(/^studio__/, "")

/** Assistant chat text that asks the user something (the brief: every question goes through the card). */
export function asksInChat(text: string): boolean {
  const t = text.replace(/```[\s\S]*?```/g, "").trim()
  // A question to the user: a sentence ending in "?" in the last two lines (not a quoted heading or a code comment).
  const tail = t.split("\n").filter((l) => l.trim()).slice(-2).join(" ")
  return /\?["”')\]]*\s*$/.test(tail) || /\b(would you like|do you want|should I|shall I|want me to|let me know (if|whether|which|what))\b[^.!]*\?/i.test(t)
}

/** Assistant text that narrates tool steps instead of talking about the user's thing. */
const NARRATION = [
  /\b(let me|i'?ll|i will|i'?m going to|now i'?ll|first,? i'?ll|next,? i'?ll)\s+(now\s+)?(read|open|load|inspect|look (at|through)|search|grep|run|call|use|list|cat)\b/i,
  /\bSKILL\.md\b|\.claude\/skills|\bskill\b.{0,30}\b(read|load|open)|\b(read|load|open)\w*\b.{0,30}\bskill/i,
  /\b(render_part|check_part|slice_part|preview_slice|request_print|share_plan|update_assembly|AskUserQuestion|apply_patch|tool call)\b/,
]
export const narrates = (text: string) => NARRATION.some((r) => r.test(text))

export interface ToolCall {
  itemId: string
  name: string
  input: unknown
  seq: number
  runId: string | null
  done: boolean
  isError: boolean
  text: string
  doneSeq: number | null
}

export interface QuestionRound {
  requestId: string
  seq: number
  runId: string | null
  questions: { question: string; header: string; options: { label: string; description: string }[] }[]
  review: boolean
}

export interface SessionFacts {
  userTexts: { seq: number; runId: string | null; text: string; queued: boolean }[]
  assistantTexts: { seq: number; runId: string | null; itemId: string | null; text: string }[]
  tools: ToolCall[]
  questions: QuestionRound[]
  runEnds: { seq: number; runId: string | null; type: string; error?: string; tokens: number; costUsd: number | null }[]
  notices: { seq: number; level: string; text: string; code?: string }[]
  inputStatus: Map<string, string>
}

/** `runtime`: Codex reports input tokens with the cached part included (the others report it apart). */
export function facts(events: AgentEventEnvelope[], runtime?: string): SessionFacts {
  const f: SessionFacts = { userTexts: [], assistantTexts: [], tools: [], questions: [], runEnds: [], notices: [], inputStatus: new Map() }
  const byItem = new Map<string, ToolCall>()
  for (const env of [...events].sort((a, b) => a.seq - b.seq)) {
    const ev = env.event
    switch (ev.type) {
      case "run.started":
        f.userTexts.push({ seq: env.seq, runId: env.runId, text: ev.input.text, queued: !!ev.queued })
        break
      case "message.completed":
        if (ev.role === "assistant" && ev.kind === "text" && !ev.parentToolId && ev.text.trim()) f.assistantTexts.push({ seq: env.seq, runId: env.runId, itemId: env.itemId, text: ev.text })
        break
      case "tool.started": {
        if (ev.parentToolId) break
        const id = env.itemId ?? `seq:${env.seq}`
        const prev = byItem.get(id)
        if (prev) {
          prev.input = ev.input ?? prev.input
          break
        }
        const t: ToolCall = { itemId: id, name: toolName(ev.name), input: ev.input, seq: env.seq, runId: env.runId, done: false, isError: false, text: "", doneSeq: null }
        byItem.set(id, t)
        f.tools.push(t)
        break
      }
      case "tool.completed": {
        const t = env.itemId ? byItem.get(env.itemId) : undefined
        if (t) Object.assign(t, { done: true, isError: ev.isError, text: ev.text, doneSeq: env.seq })
        break
      }
      case "question.requested":
        f.questions.push({
          requestId: ev.requestId,
          seq: env.seq,
          runId: env.runId,
          questions: ev.questions.map((q) => ({ question: q.question, header: q.header, options: q.options.map((o) => ({ label: o.label, description: o.description })) })),
          review: ev.questions.some((q) => REVIEW_Q.test(q.question)),
        })
        break
      case "input.status":
        if (env.runId) f.inputStatus.set(env.runId, ev.status)
        break
      case "notice":
        f.notices.push({ seq: env.seq, level: ev.level, text: ev.text, code: ev.code })
        break
      default:
        if (RUN_END.has(ev.type)) {
          const e = ev as Ev<"run.completed"> | Ev<"run.failed"> | Ev<"run.interrupted">
          const u = e.result?.usage
          const tk = u?.tokens
          const tokens = tk ? (tk.input ?? 0) + (tk.output ?? 0) + (runtime === "codex" ? 0 : (tk.cacheRead ?? 0) + (tk.cacheWrite ?? 0)) : 0
          f.runEnds.push({ seq: env.seq, runId: env.runId, type: ev.type, error: "error" in e ? e.error : undefined, tokens, costUsd: u ? (u.billedUsd ?? u.estimatedApiUsd ?? null) : null })
        }
    }
  }
  return f
}

export type Check = { ok: boolean | null; detail?: string }
export type Checks = Record<string, Check>

const yes = (ok: boolean, detail?: string): Check => ({ ok, ...(detail ? { detail } : {}) })
const firstSeq = (ts: ToolCall[], name: string | RegExp, after = -1) =>
  ts.find((t) => (typeof name === "string" ? t.name === name : name.test(t.name)) && t.seq > after && t.done && !t.isError)?.seq ?? null

/**
 * Checks every session gets: question discipline, chat hygiene, timeline integrity (order, duplicates, nothing left
 * waiting), and for design sessions the brief's flow (render -> check -> plan -> review card -> slice -> preview ->
 * print). `sent` = what the harness typed, in order (the user's bubbles must match it).
 */
export function commonChecks(
  events: AgentEventEnvelope[],
  sent: string[],
  o: { design?: boolean; discovery?: boolean; printed?: boolean; answerLines?: Set<string> } = {}
): Checks {
  const f = facts(events)
  const c: Checks = {}
  // --- timeline integrity
  // answers to a card whose turn had ended arrive as the user's next message (their own bubble): not typed text
  const bubbles = f.userTexts.map((u) => u.text).filter((t) => !o.answerLines?.has(t))
  c.bubblesInOrder = yes(JSON.stringify(bubbles) === JSON.stringify(sent), JSON.stringify(bubbles) === JSON.stringify(sent) ? undefined : `bubbles ${JSON.stringify(bubbles).slice(0, 300)} vs sent ${JSON.stringify(sent).slice(0, 300)}`)
  const seqs = events.map((e) => e.seq)
  c.seqUnique = yes(new Set(seqs).size === seqs.length, `${seqs.length - new Set(seqs).size} duplicate seq`)
  const dupTexts = f.assistantTexts.filter((t, i) => f.assistantTexts.findIndex((x) => x.text.trim() === t.text.trim()) !== i)
  c.noDuplicateAssistantText = yes(!dupTexts.length, dupTexts.map((d) => d.text.slice(0, 80)).join(" | "))
  const toolDupes = f.tools.filter((t, i) => f.tools.findIndex((x) => x.itemId === t.itemId) !== i)
  c.noDuplicateToolRows = yes(!toolDupes.length)
  // a run end closes its open rows (the timeline marks them done), so only rows after the last run end count
  const lastEnd = f.runEnds.at(-1)?.seq ?? -1
  const unfinished = f.tools.filter((t) => !t.done && t.seq > lastEnd)
  c.toolsFinished = yes(unfinished.length === 0, unfinished.map((t) => t.name).join(", "))
  const stillWaiting = f.userTexts.filter((u) => u.queued && u.runId && f.inputStatus.get(u.runId) !== "received" && f.inputStatus.get(u.runId) !== "dropped")
  c.noMessageLeftWaiting = yes(!stillWaiting.length, stillWaiting.map((u) => u.text).join(" | "))
  const dropped = f.userTexts.filter((u) => u.runId && f.inputStatus.get(u.runId) === "dropped")
  c.noMessageDropped = yes(!dropped.length, dropped.map((u) => u.text).join(" | "))
  // every AskUserQuestion card follows its tool row (or has one), and is the latest thing asked
  const qRowsBefore = f.questions.every((q) => {
    const row = f.tools.find((t) => t.name === "AskUserQuestion" && t.seq <= q.seq + 2 && t.seq >= q.seq - 50)
    return !row || row.seq <= q.seq
  })
  c.questionAfterToolRow = yes(qRowsBefore)
  c.runsFailed = yes(!f.runEnds.some((r) => r.type === "run.failed"), f.runEnds.filter((r) => r.type === "run.failed").map((r) => r.error?.slice(0, 160)).join(" | "))
  // --- question discipline
  const discovery = f.questions.filter((q) => !q.review)
  const allQs = discovery.flatMap((q) => q.questions)
  c.everyQuestionHasRecommended = allQs.length ? yes(allQs.every((q) => q.options.some((o) => /\(recommended\)/i.test(o.label))), allQs.filter((q) => !q.options.some((o) => /\(recommended\)/i.test(o.label))).map((q) => q.question).join(" | ")) : { ok: null }
  const chatQs = f.assistantTexts.filter((t) => asksInChat(t.text))
  c.noChatTextQuestions = yes(!chatQs.length, chatQs.map((t) => t.text.slice(-140)).join(" | "))
  const narr = f.assistantTexts.filter((t) => narrates(t.text))
  c.noToolNarration = yes(narr.length <= 1, `${narr.length}: ${narr.map((t) => t.text.slice(0, 100)).join(" | ")}`)
  const texts = new Set<string>()
  const repeated = allQs.filter((q) => {
    const k = q.question.toLowerCase().replace(/\W+/g, " ").trim()
    if (texts.has(k)) return true
    texts.add(k)
    return false
  })
  c.noRepeatedQuestion = yes(!repeated.length, repeated.map((q) => q.question).join(" | "))
  if (o.discovery) {
    const first = discovery[0]
    const n = first?.questions.length ?? 0
    const designedFirst = first ? f.tools.some((t) => /^(Write|Edit)$/.test(t.name) && t.seq < first.seq && /\.scad/.test(JSON.stringify(t.input))) : true
    c.discoveryCard = yes(!!first && n >= 1 && n <= 4 && !designedFirst, first ? `${discovery.length} round(s), first has ${n} question(s)${designedFirst ? ", designed before asking" : ""}` : "no discovery question card")
  }
  if (o.design) {
    const t = f.tools
    const review = f.questions.find((q) => q.review)
    const render = firstSeq(t, "render_part")
    c.rendered = yes(render !== null)
    c.checked = yes(firstSeq(t, "check_part") !== null)
    c.planShared = yes(t.some((x) => x.name === "share_plan"))
    c.reviewByCard = yes(!!review, review ? undefined : "no 'How does this look?' card")
    c.renderBeforeReview = review ? yes(render !== null && render < review.seq) : { ok: null }
  }
  if (o.printed) {
    const t = f.tools
    const slice = [...t].reverse().find((x) => /^slice_(part|plate)$/.test(x.name) && x.done && !x.isError)
    const preview = slice ? firstSeq(t, "preview_slice", slice.seq) : null
    const print = t.find((x) => x.name === "request_print" && x.done)
    c.sliced = yes(!!slice)
    c.previewAfterLastSlice = yes(preview !== null)
    c.printRequested = yes(!!print && (preview === null || print.seq > preview), print ? undefined : "no request_print")
    const refused = t.filter((x) => /^slice_(part|plate)|request_print$/.test(x.name) && /hasn't approved|not approved|approve/i.test(x.text) && x.isError)
    c.noGateRefusals = yes(!refused.length, refused.map((x) => `${x.name}: ${x.text.slice(0, 100)}`).join(" | "))
  }
  return c
}

/** Tokens and API-equivalent cost of a session (sum over run ends; Claude reports a cumulative session cost). */
export function usageOf(events: AgentEventEnvelope[], runtime?: string): { tokens: number; costUsd: number | null; runs: number } {
  const f = facts(events, runtime)
  const costs = f.runEnds.map((r) => r.costUsd).filter((x): x is number => typeof x === "number")
  return { tokens: f.runEnds.reduce((a, r) => a + r.tokens, 0), costUsd: costs.length ? Math.max(...costs) : null, runs: f.runEnds.length }
}

/** A readable excerpt of the session for the report: user bubbles, assistant text, question cards, tool names. */
export function excerpt(events: AgentEventEnvelope[], max = 60): string {
  const lines: string[] = []
  for (const env of [...events].sort((a, b) => a.seq - b.seq)) {
    const ev = env.event
    if (ev.type === "run.started") lines.push(`USER${ev.queued ? " (while busy)" : ""}: ${ev.input.text}`)
    else if (ev.type === "message.completed" && ev.role === "assistant" && ev.kind === "text" && !ev.parentToolId) lines.push(`AI: ${ev.text.replace(/\s+/g, " ").slice(0, 240)}`)
    else if (ev.type === "question.requested") lines.push(`CARD: ${ev.questions.map((q) => `${q.question} [${q.options.map((o) => o.label).join(" / ")}]`).join(" || ").slice(0, 300)}`)
    else if (ev.type === "tool.started" && !ev.parentToolId) {
      const n = toolName(ev.name)
      if (n !== "AskUserQuestion" && !/^(Read|Grep|Glob|LS|ToolSearch|TodoWrite)$/.test(n)) {
        const last = lines[lines.length - 1]
        if (last?.startsWith("  tools:")) lines[lines.length - 1] = `${last}, ${n}`
        else lines.push(`  tools: ${n}`)
      }
    } else if (ev.type === "input.status") lines.push(`  (message ${ev.status})`)
    else if (ev.type === "run.interrupted" || ev.type === "run.failed") lines.push(`  == ${ev.type}${"error" in ev ? `: ${ev.error.slice(0, 160)}` : ""}`)
    else if (ev.type === "notice" && ev.code !== "session.started") lines.push(`  NOTICE: ${ev.text.slice(0, 160)}`)
  }
  return (lines.length > max ? [...lines.slice(0, 10), `  … ${lines.length - max} lines …`, ...lines.slice(-(max - 10))] : lines).join("\n")
}
