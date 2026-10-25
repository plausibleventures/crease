// Has the user approved the current design? Slicing and print requests by the agent wait for it.
//
// Approval comes from:
//  - the user answering the "How does this look?" review question with "Looks great"; or
//  - a user message that plainly asks to print or slice ("print it", "send it to the printer", "slice it",
//    "just make it and print", "can you print both?").
// It is tied to the design revision (revision.ts) at that moment: any later change to the design, from any source
// (agent Write/Edit or Bash, set_parameters, the user's editor or Customizer, a restore or branch switch), makes it
// stale, because the gate recomputes the revision when it runs. The revision covers what the user saw (part
// sources, overrides, parts list, colours, placements, motions), not the picture guide or shopping list, so building
// the guide after "Looks great" keeps the approval; a colour change doesn't.
// Only the agent's own slice_part / slice_plate / request_print are gated. The toolbar's Slice / Send to printer
// buttons are user actions and never go through here. The final print confirmation is always the app's dialog.
// Survives a restart: the approved revision (only that, never a yes/no) is saved in the project's .studio/approval.json
// and re-validated like the in-memory one: it counts only while the design still hashes to that revision. .studio/
// is app-owned (the agent can't write it; a build pack never carries it), and a stale or unreadable file is just
// "not approved", so the worst a hand-copied file can do is skip one "How does this look?" for the identical design;
// the print itself still needs the user's OK in the app's dialog.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assertAppDir } from "../projects/paths"
import { blankDesignAt } from "../projects/store"
import { deps } from "./deps"
import { designRevision } from "./revision"

const approved = new Map<string, string>() // projectId -> design revision the user approved
const loaded = new Set<string>() // projects whose saved approval has been read since start

const approvalFile = (projectId: string) => join(deps.projectDir(projectId), ".studio", "approval.json")
const REVISION_RE = /^[0-9a-f]{16}$/

/** Read the saved approval once per project (after a restart). Anything odd = not approved. */
function load(projectId: string) {
  if (loaded.has(projectId)) return
  loaded.add(projectId)
  try {
    assertAppDir(deps.projectDir(projectId), ".studio")
    const j = JSON.parse(readFileSync(approvalFile(projectId), "utf8")) as { revision?: unknown }
    if (typeof j?.revision === "string" && REVISION_RE.test(j.revision) && !approved.has(projectId)) approved.set(projectId, j.revision)
  } catch {
    /* none saved (or unreadable): not approved */
  }
}

function persist(projectId: string, rev: string | null) {
  try {
    const root = deps.projectDir(projectId)
    assertAppDir(root, ".studio")
    const file = approvalFile(projectId)
    if (!rev) {
      if (existsSync(file)) rmSync(file, { force: true })
      return
    }
    mkdirSync(join(root, ".studio"), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify({ revision: rev, approvedAt: new Date().toISOString() }) + "\n")
    renameSync(`${file}.tmp`, file)
  } catch {
    /* best effort: the in-memory approval still holds until a restart */
  }
}

/** The revision the user approved, if any (it may be stale; see isApproved). */
export const approvedRevision = (projectId: string) => {
  load(projectId)
  return approved.get(projectId) ?? null
}
/** Approved, and the design hasn't changed since. */
export const isApproved = (projectId: string) => {
  load(projectId)
  const a = approved.get(projectId)
  return a !== undefined && a === designRevision(projectId)
}
/** Approve the design as it is right now (true), or withdraw approval (false). Saved for after a restart. */
export const setApproved = (projectId: string, v: boolean) => {
  loaded.add(projectId) // what we decide now wins over anything saved earlier
  const rev = v ? designRevision(projectId) : null
  if (rev) approved.set(projectId, rev)
  else approved.delete(projectId)
  persist(projectId, rev)
}

/** Tests: forget what's in memory, as after a server restart. */
export const forgetApprovalsInMemory = () => {
  approved.clear()
  loaded.clear()
}

// ---------------------------------------------------------------------------------------------
// Reading the user's words. Simple and predictable on purpose: when in doubt it is NOT a request to print, and the
// agent just asks. A false "no" costs one question; a false "yes" slices something the user wanted changed.
// ---------------------------------------------------------------------------------------------

const PRINT_INTENT =
  /\b(print (it|this|that|them|these|those|both|all|everything|one|two|\d+)|(and|then|now|go ahead and|please) print|slice (it|this|that|them|both|all)|send (it |this |that |them )?to (the |my )?printer|start (the |a )?print(ing)?|ready to print|yes,? print)\b/i

/**
 * Words that make a message hesitant, conditional or negative. If any appears anywhere in the message, it doesn't
 * count as asking to print ("Please do not print it yet", "before you print, make it taller", "wait", "hold off",
 * "looks good but…", "should I print it?"). A bare "No, just print it" (answering "Anything else?") still counts.
 */
const HOLD =
  /\b(not|never|no need|no longer|don'?t|dont|do not|does not|doesn'?t|can'?t|cannot|won'?t|wouldn'?t|shouldn'?t|isn'?t|aren'?t|didn'?t|haven'?t|wait|hold (off|on|it)|stop|cancel|pause|later|yet|before|until|unless|instead|first|but|except|actually|never ?mind|maybe|perhaps|if|should|shall|wonder|whether)\b/i

/** A question only counts when it's a polite request aimed at the agent: "can you / could you / would you / will you". */
const REQUEST_LEAD = /^(ok(ay)?\s+|so\s+|and\s+)?(please\s+)?(can|could|would|will) you(\s+please)?(\s+(just|now|go ahead and))?$/i

const norm = (t: string) => t.replace(/[‘’`]/g, "'")

/** Does this message (or answer) plainly ask to print or slice the design? */
export function asksToPrint(text: string): boolean {
  const t = norm(text)
  if (HOLD.test(t)) return false
  for (const sentence of t.match(/[^.!?\n]+[.!?]*/g) ?? []) {
    const m = PRINT_INTENT.exec(sentence)
    if (!m) continue
    if (!/\?\s*$/.test(sentence)) return true
    const lead = (sentence.slice(0, m.index).split(/[,;:—–]|\s-\s/).pop() ?? "").trim()
    if (REQUEST_LEAD.test(lead)) return true
  }
  return false
}

/**
 * Holds back printing itself ("don't print it yet", "wait before slicing", "hold off on the print"). Withdraws
 * approval. Only a hold word right before the print word counts: "make sure the print is reliable, it's okay if it's
 * slow" or "doesn't our design need careful printing?" are about how to print, and withdrawing approval for them made
 * the designer ask "How does this look?" again for a design that hadn't changed (Cyberbear, 2026-10-17).
 */
const HOLDS_PRINT =
  /\b(not|never|don'?t|dont|do not|no|wait|hold( off| on)?|stop|cancel|pause|before|until)\s+(?:(?:on|with|the|a|it|this|that|to|you|yet|any|more|again|for now|now)\s+){0,3}(print|printing|slice|slicing|send(ing)? it)\b|\b(print|slice|send)\w*\s+(?:(?:it|this|that|them)\s+)?(yet|later)\b/i
export const holdsPrint = (text: string) => HOLDS_PRINT.test(norm(text))

/** A "How does this look?" answer that approves: starts with "Looks great/good" (a designer's own option may lead with
 * "Got it, looks great") and holds nothing back, or asks to print. */
export const approvesDesign = (answer: string) =>
  (/^\s*((got it|yes|yeah|yep|ok(ay)?|great|nice|perfect)[,!.]?\s+)?(looks|it looks|they look) (great|good|perfect|right)/i.test(answer) && !HOLD.test(norm(answer))) || asksToPrint(answer)

/**
 * Does a file write change geometry? (.scad sources in parts/ or lib/, Blender part scripts and the lib/*.py they
 * import.) Not assembly.scad or the generated lib/studio_assembly*.scad: they only draw the picture guide, which isn't
 * part of what the user approves.
 */
export const isGeometryPath = (p: string) =>
  !/(^|\/)build\//.test(p) &&
  ((/\.scad$/i.test(p) && !/(^|\/)assembly\.scad$/i.test(p) && !/(^|\/)studio_assembly[\w-]*\.scad$/i.test(p)) || /\.blend\.py$/i.test(p) || /(^|\/)lib\/[^/]+\.py$/i.test(p))

export const APPROVAL_REFUSAL =
  "Not yet: the user hasn't approved this design. Show it (a sentence or two about what they'll get), then ask with AskUserQuestion \"How does this look?\" (Looks great / Make it bigger / Make it smaller / Change something…). Slice and request the print only after they pick \"Looks great\" or ask you to print."

export const STALE_APPROVAL_REFUSAL =
  "Not yet: the design changed after the user approved it (a file, a setting, or a restored version), so their \"Looks great\" was for an older version. Render the current design, show it in a sentence or two, and ask \"How does this look?\" again. Slice and request the print after they approve this version."

// ---------------------------------------------------------------------------------------------
// Event handlers (pure apart from the map above). index.ts and tools.ts call these; approval.test.ts tests them.
// ---------------------------------------------------------------------------------------------

// "How does your phone stand look?", "How do the new photo-based fronts look?" (Codex words it its own way), but not a
// discovery question like "How do you want it to look?".
export const REVIEW_Q = /how (does|do) (?!you\b)[\w ,'’-]{1,60}? looks?\b|ready to print/i
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

/** The user's own chat message. */
export function onUserMessage(projectId: string, text: string) {
  if (asksToPrint(text)) setApproved(projectId, true)
  else if (holdsPrint(text)) setApproved(projectId, false)
}

/** Answers to an AskUserQuestion round (question text -> answer). */
export function onQuestionsAnswered(projectId: string, questions: { question: string }[], answers: Record<string, string>) {
  const review = questions.find((q) => REVIEW_Q.test(q.question))
  if (review) setApproved(projectId, approvesDesign(answers[review.question] ?? ""))
  else if (Object.values(answers).some(asksToPrint)) setApproved(projectId, true)
  else if (Object.values(answers).some(holdsPrint)) setApproved(projectId, false)
}

/**
 * A tool call that was allowed to run: the agent's own geometry edits withdraw approval straight away. A belt on top
 * of the braces: the gate compares revisions anyway, which also catches Bash, UI edits and restores.
 */
export function onToolAllowed(projectId: string, toolName: string, input: Record<string, unknown>) {
  const short = toolName.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "")
  if (short === "set_parameters" || short === "set_orientation") setApproved(projectId, false)
  else if (WRITE_TOOLS.has(toolName) && isGeometryPath(String(input.file_path ?? input.notebook_path ?? ""))) setApproved(projectId, false)
}

export const BLANK_DESIGN_AGENT_REFUSAL =
  "Not yet: nothing is designed yet (the project still holds the blank starter box). Write the design the user asked for, render it and show it before slicing or printing."

/** The project still holds only the blank starter part: never sliced or printed (U1). */
export function blankDesignGate(projectId: string): string | null {
  try {
    return blankDesignAt(deps.projectDir(projectId)) ? BLANK_DESIGN_AGENT_REFUSAL : null
  } catch {
    return null
  }
}

/** For the agent's slice_part / slice_plate / request_print: a refusal message, or null if this design is approved. */
export function sliceOrPrintGate(projectId: string): string | null {
  if (isApproved(projectId)) return null
  return approved.has(projectId) ? STALE_APPROVAL_REFUSAL : APPROVAL_REFUSAL
}
