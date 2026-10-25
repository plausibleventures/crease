// How the designer chat shows tool calls: plain names, what a failed or refused call means, and runs of the same
// step folded into one line.
import type { TimelineItem } from "./timeline"

export type ToolItem = Extract<TimelineItem, { kind: "tool" }>

/** What a tool did, in a few plain words (the panel's Details show the raw tool name and its input). */
export function friendlyTool(name: string, done = true): string {
  const n = name.toLowerCase()
  if (n === "edit" || n === "multiedit" || n === "write") return done ? "Changed the design" : "Change"
  if (n === "read") return "Looked at a file"
  if (n === "glob" || n === "grep" || n === "ls") return "Searched files"
  if (n === "bash") return "Ran a command"
  if (n === "todowrite") return "Updated the to-do list"
  if (n === "save_checkpoint") return done ? "Saved a version" : "Save a version"
  if (n.includes("render")) return done ? "Made a picture" : "Picture"
  if (n.includes("check")) return done ? "Checked the part" : "Check"
  if (n.includes("slice")) return done ? "Sliced" : "Slice"
  if (n.includes("print")) return "Printer"
  if (n.includes("assembly")) return "Assembly"
  const t = n.replace(/_/g, " ")
  return t[0].toUpperCase() + t.slice(1)
}

export interface ToolOutcome {
  /** waiting: the app held the step back until something else happens first (the user's OK, the guide) */
  state: "running" | "done" | "waiting" | "failed"
  /** one short line for the row; null when it worked */
  reason: string | null
}

const MAX_REASON = 90

/**
 * A step's outcome in the user's terms. The app's own "Not yet" / "Almost there" refusals (server/agent/approval.ts,
 * done.ts) are not failures: the designer does the missing step and tries again, so they read as waiting, with why.
 */
export function toolOutcome(item: Pick<ToolItem, "status" | "resultText">): ToolOutcome {
  if (item.status === "running") return { state: "running", reason: null }
  if (item.status === "done") return { state: "done", reason: null }
  const text = (item.resultText ?? "").trim().replace(/^Error:\s*/i, "")
  if (/^(not yet|almost there):/i.test(text)) {
    const reason = /changed after the user approved/i.test(text)
      ? "Changed since your OK"
      : /hasn't approved|approve/i.test(text)
        ? "Waits for your OK"
        : /nothing is designed/i.test(text)
          ? "Nothing designed yet"
          : /picture guide/i.test(text)
            ? "Needs the picture guide first"
            : "Not yet"
    return { state: "waiting", reason }
  }
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? ""
  return { state: "failed", reason: line ? (line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line) : "It didn't work" }
}

/** Tool rows with their own look (questions, plans) never fold. */
const OWN_ROW = (name: string) => name === "AskUserQuestion" || name.endsWith("__share_plan")

const shortName = (name: string) => name.match(/^mcp__.+?__(.+)$/)?.[1] ?? name

export type TimelineEntry = { kind: "item"; item: TimelineItem } | { kind: "group"; key: string; label: string; items: ToolItem[] }

/**
 * Fold runs of the same step ("Sliced", "Sliced", "Sliced") into one entry. Steps that are still running stay on
 * their own, so the newest activity is always visible.
 */
export function foldRepeats(items: TimelineItem[]): TimelineEntry[] {
  const out: TimelineEntry[] = []
  let run: ToolItem[] = []
  let runLabel = ""
  const flush = () => {
    if (run.length > 1) out.push({ kind: "group", key: `g:${run[0].key}`, label: runLabel, items: run })
    else if (run.length === 1) out.push({ kind: "item", item: run[0] })
    run = []
  }
  for (const it of items) {
    const foldable = it.kind === "tool" && !OWN_ROW(it.name) && it.status !== "running"
    if (!foldable) {
      flush()
      out.push({ kind: "item", item: it })
      continue
    }
    const label = friendlyTool(shortName(it.name))
    if (run.length && (label !== runLabel || it.sub !== run[0].sub)) flush()
    runLabel = label
    run.push(it)
  }
  flush()
  return out
}
