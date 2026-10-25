// R11g: the handoff summary, collected from the project's own records (deterministic: no model call). See handoff.ts.
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { HandoffSummary, PrintJobState } from "../../shared/types"
import { listPrints } from "../db"
import { projectOutcomes } from "../outcomes"
import { describeOutcome } from "../outcomes/brief"
import { listIdeas } from "../projects/ideas"
import { projectOverview } from "../projects/overview"
import { listCheckpoints } from "../projects/store"
import { readMotionRecord } from "../projects/validity"
import { deps } from "./deps"
import { doneChecklist, failingChecks } from "./done"
import { latestHandoffInto, readHandoff, scrubDeep, transcriptFacts, trimText } from "./handoff"
import { designRevision } from "./revision"
import { readEvents } from "./transcript"

const quiet = async <T>(f: () => T | Promise<T>, fallback: T): Promise<T> => {
  try {
    return await f()
  } catch {
    return fallback
  }
}

/** Files under refs/ (the user's photos, artwork, drawings), names only, two levels deep. */
function refFiles(root: string): string[] {
  const dir = join(root, "refs")
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (abs: string, rel: string, depth: number) => {
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith(".")) continue
      const a = join(abs, name)
      const r = rel ? `${rel}/${name}` : name
      if (statSync(a).isDirectory()) {
        if (depth < 1) walk(a, r, depth + 1)
      } else out.push(r)
    }
  }
  walk(dir, "", 0)
  return out.slice(0, 30)
}

const STATE: Record<PrintJobState, string> = {
  printing: "printing now",
  complete: "finished",
  cancelled: "cancelled",
  error: "stopped with an error",
}

const dedupe = <T>(xs: T[], key: (x: T) => string) => {
  const seen = new Set<string>()
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)))
}

/**
 * Everything the next designer needs, from records: the chat it comes from (and the handoff that chat started from,
 * so requirements survive a chain of handoffs), the overview, checks, motion check, supplies, prints, refs.
 * Redacted: no secrets, no absolute paths.
 */
export async function collectHandoffSummary(projectId: string, fromSessionId: string | null): Promise<HandoffSummary> {
  const project = await deps.getProject(projectId)
  const root = deps.projectDir(projectId)
  const events = fromSessionId ? await quiet(() => readEvents(projectId, fromSessionId), []) : []
  const facts = transcriptFacts(events)

  // A chat that started from a handoff (or was caught up by one on a resume): the earlier requirements and decisions
  // carry over, so they survive a chain of handoffs.
  const entry = fromSessionId ? project.sessions.find((x) => x.id === fromSessionId) : undefined
  const prior = fromSessionId
    ? (latestHandoffInto(projectId, fromSessionId) ?? (entry?.handoff?.id ? readHandoff(projectId, entry.handoff.id) : null))?.summary
    : null
  const firstAsk = prior?.requirements.firstAsk ?? facts.firstAsk
  // (a resumed chat repeats requests the prior summary already has: once each, never the first request again)
  const asks = dedupe(
    [...(prior ? [...prior.requirements.asks, ...(facts.firstAsk ? [facts.firstAsk] : [])] : []), ...facts.asks].map((a) => trimText(a, 300)),
    (a) => a,
  )
    .filter((a) => a !== (firstAsk ? trimText(firstAsk, 300) : null))
    .slice(-8)
  const answers = dedupe([...(prior?.requirements.answers ?? []), ...facts.answers].reverse(), (a) => a.question).reverse()
  const decisions = dedupe([...(prior?.decisions ?? []), ...facts.plans], (p) => `${p.title}|${p.bullets.join("|")}`).slice(-6)
  const pins = dedupe([...(prior?.references.pins ?? []), ...facts.pins], (p) => p).slice(-8)

  const ov = await quiet(() => projectOverview(projectId), null)
  const ideas = await quiet(() => listIdeas(projectId), null)
  const versions = await quiet(() => listCheckpoints(projectId, 1), null)
  const partIds = project.parts.map((p) => p.id)
  const failing = await quiet(() => failingChecks(root, partIds), [])
  // the checklist's plan item is tracked in memory (lost on restart): the transcript's plan cards are the record
  const open = (await quiet(() => doneChecklist(projectId), [])).filter((l) => !/^Failing check:/.test(l) && !(decisions.length && /share_plan/.test(l)))
  const motion = await quiet(() => {
    const r = readMotionRecord(root)
    if (!r) return null
    const stale = ov?.outOfDate.some((o) => /motion/i.test(o.what))
    return `${r.check.ok ? "passed" : "not passing"}: ${r.check.summary}${stale ? " (out of date: the design changed since)" : ""}`
  }, null)
  const last = ov?.lastPrint ?? null
  const lastPrint = last
    ? `Last print ${STATE[last.state] ?? last.state} (${(last.finishedAt ?? last.startedAt).slice(0, 10)})${last.state !== "printing" ? (last.rated ? "; the user rated it" : "; not rated yet") : ""}`
    : null
  const printCount = await quiet(() => listPrints(projectId, 200).length, 0)
  const outcomes = (await quiet(() => projectOutcomes(projectId), [])).slice(0, 5).map(describeOutcome)

  const summary: HandoffSummary = {
    project: { name: project.name, description: project.description ?? null },
    requirements: { firstAsk: firstAsk ? trimText(firstAsk, 800) : null, answers, asks },
    design: {
      idea: ideas?.ideas.find((i) => i.current)?.name ?? null,
      version: versions?.checkpoints[0] ? { short: versions.checkpoints[0].short, message: trimText(versions.checkpoints[0].message, 120) } : null,
      revision: await quiet(() => designRevision(projectId), null),
      size: ov?.hasDesign && ov.size ? { mm: ov.size.mm, basis: ov.size.basis === "assembled" ? "assembled" : ov.size.basis === "part" ? "the part" : "largest part" } : null,
      parts: ov?.hasDesign
        ? ov.parts.map((p) => ({ id: p.id, name: p.name, qty: p.qty, sizeMm: p.sizeMm, colors: p.colors, error: p.error }))
        : [],
    },
    approved: !!ov?.approved,
    decisions,
    checks: {
      failing,
      outOfDate: (ov?.outOfDate ?? []).map((o) => `${o.what}${o.reasons.length ? ` (${o.reasons.join("; ")})` : ""}`),
      motion,
      open,
    },
    supplies: ov?.supplies ? ov.supplies.items.map((i) => ({ name: i.name, need: i.needText ?? (i.need != null ? String(i.need) : "") })) : null,
    prints: { last: lastPrint ? `${lastPrint}${printCount > 1 ? ` · ${printCount} prints in all` : ""}` : null, outcomes },
    references: { files: refFiles(root), pins },
    recent: facts.recent,
  }
  return scrubDeep(summary, root)
}
