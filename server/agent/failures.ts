// Recent failed runs (R11c "recent failed runs" on the Agents screen): one JSON line per failed run, stopped-by-
// budget run or sign-in failure, in <STUDIO_HOME>/agent-failures.jsonl. Bounded; error text is redacted.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentFailure } from "../../shared/types"
import { STUDIO_HOME } from "../config"
import { emit } from "../events"
import { redactSecrets } from "../secrets"

const file = () => join(STUDIO_HOME, "agent-failures.jsonl")
const KEEP = 200

export function recordFailure(f: Omit<AgentFailure, "ts">): AgentFailure {
  const entry: AgentFailure = { ts: new Date().toISOString(), ...f, error: redactSecrets(f.error).slice(0, 2000) }
  try {
    appendFileSync(file(), JSON.stringify(entry) + "\n")
    const lines = readFileSync(file(), "utf8").split("\n").filter(Boolean)
    if (lines.length > KEEP * 2) writeFileSync(file(), lines.slice(-KEEP).join("\n") + "\n")
  } catch (e) {
    console.error("[agent] failure log write failed", e)
  }
  emit({ type: "agent.failure", failure: entry })
  return entry
}

/** Newest first. */
export function listFailures(opts: { limit?: number; profileId?: string | null } = {}): AgentFailure[] {
  if (!existsSync(file())) return []
  const out: AgentFailure[] = []
  for (const line of readFileSync(file(), "utf8").split("\n").reverse()) {
    if (!line) continue
    try {
      const f = JSON.parse(line) as AgentFailure
      if (opts.profileId !== undefined && f.profileId !== opts.profileId) continue
      out.push(f)
      if (out.length >= (opts.limit ?? 20)) break
    } catch {
      /* skip a torn line */
    }
  }
  return out
}
