// R22: ideas (git branches) for people. Lists every idea with a friendly name, its newest version and the chat to
// come back to, and switches between them without losing either idea's agent session.
//
// .studio/ideas.json (app state, not versioned): { names: {branch: name}, lastSession: {branch: sessionId} }.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { simpleGit } from "simple-git"
import type { Checkpoint, Idea, IdeaList, Project } from "../../shared/types"
import { currentBranch, getProject, httpError, projectDir } from "./store"

interface IdeasState {
  names: Record<string, string>
  lastSession: Record<string, string>
}

const stateFile = (projectId: string) => join(projectDir(projectId), ".studio", "ideas.json")

export function readIdeasState(projectId: string): IdeasState {
  try {
    const s = JSON.parse(readFileSync(stateFile(projectId), "utf8")) as Partial<IdeasState>
    return { names: { ...(s.names ?? {}) }, lastSession: { ...(s.lastSession ?? {}) } }
  } catch {
    return { names: {}, lastSession: {} }
  }
}

function writeIdeasState(projectId: string, s: IdeasState) {
  const f = stateFile(projectId)
  mkdirSync(join(f, ".."), { recursive: true })
  writeFileSync(f + ".tmp", JSON.stringify(s, null, 2) + "\n")
  renameSync(f + ".tmp", f)
}

/** Remember which chat was last used on an idea (so coming back to the idea brings that chat back). */
export function noteIdeaSession(projectId: string, branch: string, sessionId: string | null) {
  if (!branch || branch === "HEAD") return
  const s = readIdeasState(projectId)
  if (sessionId) s.lastSession[branch] = sessionId
  else delete s.lastSession[branch]
  writeIdeasState(projectId, s)
}

const BRANCH_RE = /^[\w./-]+$/

export async function renameIdea(projectId: string, branch: string, name: string): Promise<IdeaList> {
  if (!BRANCH_RE.test(branch)) throw httpError(400, "bad idea id")
  const list = await listIdeas(projectId)
  if (!list.ideas.some((i) => i.branch === branch)) throw httpError(404, "idea not found")
  const s = readIdeasState(projectId)
  const clean = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60)
  if (clean) s.names[branch] = clean
  else delete s.names[branch]
  writeIdeasState(projectId, s)
  return listIdeas(projectId)
}

/** Sessions that work on an idea: their recorded branch, or (no branch yet) the idea that's open now. */
export function sessionsOfIdea(project: Project, branch: string, current: string) {
  return project.sessions.filter((x) => (x.branch ?? current) === branch)
}

/** The idea's default name: the title of the chat that started it, else "First idea" / "Idea N". */
function defaultName(project: Project, branch: string, index: number, firstBranch: string | null): string {
  const starter = project.sessions.find((x) => x.branch === branch && x.forkedFrom)
  if (starter?.title) return starter.title
  if (branch === firstBranch) return "First idea"
  const m = branch.match(/^variant-(\d+)$/)
  return m ? `Idea ${Number(m[1]) + 1}` : `Idea ${index + 1}`
}

export async function listIdeas(projectId: string): Promise<IdeaList> {
  const project = await getProject(projectId)
  const dir = projectDir(projectId)
  const git = simpleGit({ baseDir: dir })
  const current = await currentBranch(projectId)
  const raw = await git
    .raw(["for-each-ref", "refs/heads", "--sort=committerdate", "--format=%(refname:short)%1f%(objectname)%1f%(objectname:short)%1f%(committerdate:iso-strict)%1f%(subject)"])
    .catch(() => "")
  const rows = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [branch, commit, short, date, subject] = l.split("\x1f")
      const m = subject.match(/^(agent|user):\s*(.*)$/)
      const tip: Checkpoint = { commit, short, date, author: (m?.[1] ?? "user") as Checkpoint["author"], message: m ? m[2] : subject }
      return { branch, tip }
    })
  // The first idea: the branch holding the project's first commit that isn't a variant (main/master).
  const firstBranch = rows.find((r) => !/^variant-\d+$/.test(r.branch))?.branch ?? null
  const state = readIdeasState(projectId)
  const names = new Map<string, string>()
  rows.forEach((r, i) => names.set(r.branch, state.names[r.branch] ?? defaultName(project, r.branch, i, firstBranch)))

  const ideas: Idea[] = []
  for (const r of rows) {
    const sessions = sessionsOfIdea(project, r.branch, current)
    const last = state.lastSession[r.branch]
    const sessionId = last && sessions.some((x) => x.id === last) ? last : (sessions[sessions.length - 1]?.id ?? null)
    let startedFrom: Idea["startedFrom"] = null
    if (r.branch !== firstBranch && firstBranch) {
      // fork point: the newest commit this idea shares with any other idea
      let best: { commit: string; date: number; other: string } | null = null
      for (const o of rows) {
        if (o.branch === r.branch) continue
        const base = (await git.raw(["merge-base", r.branch, o.branch]).catch(() => "")).trim()
        if (!base) continue
        const date = Number((await git.raw(["log", "-1", "--format=%ct", base]).catch(() => "0")).trim())
        if (!best || date > best.date) best = { commit: base, date, other: o.branch }
      }
      if (best) startedFrom = { commit: best.commit, short: best.commit.slice(0, 7), idea: names.get(best.other) ?? null }
    }
    ideas.push({ branch: r.branch, name: names.get(r.branch)!, current: r.branch === current, tip: r.tip, sessionId, sessionCount: sessions.length, startedFrom })
  }
  // first idea first, then in the order they were started (variant-1, variant-2, …)
  const order = (b: string) => (b === firstBranch ? -1 : Number(b.match(/^variant-(\d+)$/)?.[1] ?? 1e6))
  ideas.sort((a, b) => order(a.branch) - order(b.branch) || a.branch.localeCompare(b.branch))
  return { current, ideas }
}
