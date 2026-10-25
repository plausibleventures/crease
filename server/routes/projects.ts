import type { FastifyInstance } from "fastify"
import { createReadStream, existsSync, statSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import type { CheckReport, RenderResult } from "../../shared/types"
import { checkPart, listParameters, renderPart, unwatchProject, watchProject, type ParamValues } from "../cad/index"
import { clearedRender, displayUrl, isClearable } from "../cad/display"
import { closeSession, forkAgentSession, getStatus, startHandoff, switchSession } from "../agent/index"
import { duplicateProject, patchProject, trashProject } from "../projects/manage"
import { designerPick } from "./agent"
import { APP_SKILLS_DIR } from "../agent/prompt"
import { agentConfigStatus, enableAgentConfig, prepareAgentConfig, revokeAgentConfig } from "../projects/agent-config"
import { allowScripts } from "../cad/sculpt-trust"
import { upsertSession } from "../db"
import {
  commitWorkInProgress,
  createVariantBranch,
  currentBranch,
  listCheckpoints,
  restoreCheckpoint,
  currentParamSnapshot,
  noteParamEdit,
  PARAM_VERSION_IDLE_MS,
  switchToBranch,
  updateProject,
  createProject,
  ensureGitignore,
  getProject,
  httpError,
  listProjects,
  projectDir,
  resolveEditablePath,
  resolveProjectPath,
  saveCheckpoint,
} from "../projects/store"
import { projectValidity } from "../projects/validity"
import { projectOverview } from "../projects/overview"
import { isApproved, setApproved } from "../agent/approval"
import { dismissSharedNotes, isSharedFor, paramLinksAt, partOverridesAt, sharedNotesAt } from "../projects/revision"
import { emit } from "../events"
import { listIdeas, noteIdeaSession, renameIdea } from "../projects/ideas"
import { compareIdeas } from "../projects/compare"

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
  ".stl": "model/stl",
  ".3mf": "model/3mf",
  ".gcode": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".scad": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
}

// OWNER: projects/cad agent. See shared/api.md "Projects".
export default async function projectsRoutes(app: FastifyInstance) {
  app.get("/api/projects", async () => listProjects())

  app.post<{ Body: { name?: string } }>("/api/projects", async (req) => {
    const p = await createProject(req.body?.name ?? "")
    void watchProject(p.id)
    return p
  })

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const p = await getProject(req.params.id)
    void watchProject(p.id)
    void ensureGitignore(p.id).catch(() => {})
    return p
  })

  // U4 project management (shared/api.md "Projects"): rename/tags, duplicate, move to the Trash.
  app.patch<{ Params: { id: string }; Body: { name?: unknown; tags?: unknown } | undefined }>("/api/projects/:id", async (req) => {
    const p = await patchProject(req.params.id, req.body ?? {})
    emit({ type: "project.changed", projectId: p.id, paths: ["project.json"] })
    return p
  })

  app.post<{ Params: { id: string }; Body: { name?: unknown } | undefined }>("/api/projects/:id/duplicate", async (req) => {
    const p = await duplicateProject(req.params.id, req.body?.name)
    emit({ type: "project.changed", projectId: p.id, paths: ["project.json"] })
    return p
  })

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const id = req.params.id
    await getProject(id) // 400/404 first
    if ((await getStatus(id)).running) throw httpError(409, "The designer is working on this project. Stop it first.")
    // stop watching first so nothing re-renders into the folder while it moves (a later GET watches again)
    await unwatchProject(id)
    const r = await trashProject(id)
    try {
      await closeSession(id)
    } catch {
      /* no open chat */
    }
    emit({ type: "project.changed", projectId: id, paths: ["project.json"] })
    return r
  })

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/projects/:id/file", async (req) => {
    const rel = req.query.path
    if (!rel) throw httpError(400, "path is required")
    const abs = resolveProjectPath(req.params.id, rel)
    if (!existsSync(abs) || !statSync(abs).isFile()) throw httpError(404, `file not found: ${rel}`)
    return { path: rel, content: await readFile(abs, "utf8") }
  })

  app.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>("/api/projects/:id/file", async (req) => {
    const { path: rel, content } = req.body ?? {}
    if (!rel || typeof content !== "string") throw httpError(400, "path and content are required")
    await getProject(req.params.id) // 404 if missing
    const abs = resolveEditablePath(req.params.id, rel)
    await mkdir(dirname(abs), { recursive: true })
    await watchProject(req.params.id) // make sure the change is seen and rendered
    await writeFile(abs, content)
    return { ok: true }
  })

  app.get<{ Params: { id: string; partId: string } }>("/api/projects/:id/parts/:partId/parameters", async (req) =>
    listParameters(req.params.id, req.params.partId),
  )

  app.post<{ Params: { id: string; partId: string }; Body: { params?: ParamValues } | undefined }>(
    "/api/projects/:id/parts/:partId/render",
    async (req) => {
      const given = req.body?.params
      // U2: new slider values become a version once the sliders have been still for a moment (one per burst)
      if (given !== undefined) {
        const id = req.params.id
        noteParamEdit(id, currentParamSnapshot(id), PARAM_VERSION_IDLE_MS, () => emit({ type: "versions.changed", projectId: id }))
      }
      return renderPart(req.params.id, req.params.partId, given)
    },
  )

  // The part's saved Customizer overrides (what every render/check/slice uses; set by a render with params).
  app.get<{ Params: { id: string; partId: string } }>("/api/projects/:id/parts/:partId/overrides", async (req) => {
    const p = await getProject(req.params.id)
    if (!p.parts.some((x) => x.id === req.params.partId)) throw httpError(404, `part not found: ${req.params.partId}`)
    const root = projectDir(req.params.id)
    const overrides = partOverridesAt(root, req.params.partId)
    const links = paramLinksAt(root)
    return { overrides, notes: sharedNotesAt(root).filter((n) => isSharedFor(links, req.params.partId, n.name)) }
  })
  app.post<{ Params: { id: string }; Body: { names?: unknown } | undefined }>("/api/projects/:id/shared-notes/dismiss", async (req) => {
    await getProject(req.params.id)
    const names = req.body?.names
    if (names !== undefined && !(Array.isArray(names) && names.every((n) => typeof n === "string"))) throw httpError(400, "names must be a list of setting names")
    dismissSharedNotes(projectDir(req.params.id), names as string[] | undefined)
    return { ok: true as const }
  })

  app.post<{ Params: { id: string; partId: string } }>("/api/projects/:id/parts/:partId/check", async (req) =>
    checkPart(req.params.id, req.params.partId),
  )

  // R07: whether each derived artifact (renders, checks, guide, motion check) still matches the design. Computed on
  // read from content hashes; refetch on project.changed / render.done / check.done / jobs.changed.
  app.get<{ Params: { id: string } }>("/api/projects/:id/validity", async (req) => projectValidity(req.params.id))

  // R12: the project overview (read-only aggregate + the one next action) and the overview's "Approve the design".
  app.get<{ Params: { id: string } }>("/api/projects/:id/overview", async (req) => projectOverview(req.params.id))
  app.post<{ Params: { id: string }; Body: { approved?: unknown } | undefined }>("/api/projects/:id/approval", async (req) => {
    const v = req.body?.approved
    if (typeof v !== "boolean") throw httpError(400, "body must be {approved: boolean}")
    await getProject(req.params.id)
    setApproved(req.params.id, v)
    emit({ type: "jobs.changed", projectId: req.params.id })
    return { approved: isApproved(req.params.id) }
  })

  // Latest cached render + check for a part, without re-running anything.
  app.get<{ Params: { id: string; partId: string } }>("/api/projects/:id/parts/:partId/latest", async (req) => {
    const { id, partId } = req.params
    const project = await getProject(id)
    if (!project.parts.some((p) => p.id === partId)) throw httpError(404, `part not found: ${partId}`)
    const root = projectDir(id)
    const readJson = async <T,>(rel: string): Promise<T | null> => {
      try {
        return JSON.parse(await readFile(join(root, rel), "utf8")) as T
      } catch {
        return null
      }
    }
    type Meta = { front?: RenderResult["front"]; showFaceDown?: boolean; hash: string; stats: RenderResult["stats"]; images: RenderResult["images"][number]["view"][]; error?: string; errorCode?: string; notes?: string[] }
    const meta = await readJson<Meta>(`build/${partId}.render.json`)
    const url = (rel: string) => displayUrl(id, rel, meta?.hash ?? "")
    const render: RenderResult | null = meta
      ? {
          partId,
          stlUrl: meta.error || !existsSync(join(root, "build", `${partId}.stl`)) ? "" : url(`build/${partId}.stl`),
          ...(!meta.error && existsSync(join(root, "build", `${partId}.view.3mf`)) ? { modelUrl: url(`build/${partId}.view.3mf`) } : {}),
          ...(meta.front ? { front: meta.front } : {}),
          ...(meta.showFaceDown && !meta.error ? { showFaceDown: true } : {}),
          images: (meta.images ?? [])
            .filter((v) => existsSync(join(root, "renders", `${partId}-${v}.png`)))
            .map((view) => ({ view, url: url(`renders/${partId}-${view}.png`) })),
          stats: meta.stats ?? null,
          cached: true,
          durationMs: 0,
          ...(meta.error ? { error: meta.error } : {}),
          ...(meta.error && meta.errorCode ? { errorCode: meta.errorCode } : {}),
          ...(!meta.error && meta.notes?.length ? { notes: meta.notes } : {}),
        }
      : null
    const check = await readJson<CheckReport>(`.studio/checks/${partId}.json`)
    return { render, check }
  })

  /* ---- versions & ideas (see shared/api.md "Versions and ideas") ---- */

  // Re-render every part after the files changed under us (cached by content hash, so cheap), then tell the UI to
  // reconcile: artifact freshness and job staleness are recomputed from content on read (R07), so artifacts built
  // from the restored files read as current again and the rest as out of date.
  const rerenderAll = async (projectId: string) => {
    emit({ type: "jobs.changed", projectId })
    const p = await getProject(projectId)
    await Promise.all(p.parts.map((part) => renderPart(projectId, part.id).catch(() => {})))
    emit({ type: "jobs.changed", projectId })
  }

  app.get<{ Params: { id: string } }>("/api/projects/:id/checkpoints", async (req) => listCheckpoints(req.params.id))

  app.post<{ Params: { id: string; commit: string } }>("/api/projects/:id/checkpoints/:commit/restore", async (req) => {
    const r = await restoreCheckpoint(req.params.id, req.params.commit)
    void rerenderAll(req.params.id)
    return r
  })

  // "Try another idea": branch from HEAD (or an older version) + fork the agent conversation
  app.post<{ Params: { id: string }; Body: { fromCommit?: string; title?: string } | undefined }>(
    "/api/projects/:id/variants",
    async (req) => {
      const id = req.params.id
      const project = await getProject(id)
      const parentId = project.activeSessionId
      const parent = project.sessions.find((x) => x.id === parentId)
      const n = project.sessions.filter((x) => x.forkedFrom).length + 1
      const title = (req.body?.title ?? "").trim().slice(0, 80) || `Another idea ${n}`
      const { branch, previous } = await createVariantBranch(id, req.body?.fromCommit)
      let sessionId: string | null = null
      let forkCostUsd = 0
      if (parent) {
        try {
          const f = await forkAgentSession(id, parent.id, title)
          sessionId = f.sessionId
          forkCostUsd = f.inheritedCostUsd ?? 0
        } catch (e) {
          // no conversation to fork (e.g. never started): the new idea starts with a fresh chat
          app.log.warn(e)
        }
      }
      const fresh = await getProject(id)
      // sessions so far belong to the line of work we just left
      const sessions = fresh.sessions.map((x) => (x.branch ? x : { ...x, branch: previous }))
      if (sessionId) sessions.push({ id: sessionId, title, forkedFrom: parentId, branch, ...(parent?.runtime ? { runtime: parent.runtime } : {}), ...(parent && parent.profileId !== undefined ? { profileId: parent.profileId, model: parent.model ?? null } : {}), ...(forkCostUsd > 0 ? { forkCostUsd: Math.round(forkCostUsd * 1e4) / 1e4 } : {}) })
      await updateProject(id, { sessions })
      if (parentId) noteIdeaSession(id, previous, parentId)
      noteIdeaSession(id, branch, sessionId)
      if (sessionId) {
        try {
          upsertSession(id, sessionId, { title, forkedFrom: parentId, createdAt: new Date().toISOString() })
        } catch {
          /* catalog is best-effort */
        }
      }
      await switchSession(id, sessionId) // emits agent.status; null = fresh chat on the new idea
      void rerenderAll(id)
      return { branch, sessionId, title }
    },
  )

  // R11g "Try this with another designer": a new idea (branch from the open version) whose chat starts on the picked
  // designer from the app's summary of this one, so the two can be compared (Compare tab: designers + cost per idea).
  app.post<{ Params: { id: string }; Body: { profileId?: unknown; model?: unknown; markdown?: unknown; title?: unknown } | undefined }>(
    "/api/projects/:id/ideas/try-with",
    async (req) => {
      const id = req.params.id
      const b = req.body ?? {}
      if (b.profileId === undefined) throw httpError(400, "profileId is required (null = the default designer)")
      if (b.markdown !== undefined && (typeof b.markdown !== "string" || b.markdown.length > 60_000)) throw httpError(400, "markdown must be a string")
      const pick = await designerPick(id, b)
      // the user's edit of the summary (from the dialog's preview); none = the app's own, built from the same files
      const markdown = typeof b.markdown === "string" && b.markdown.trim() ? b.markdown : undefined
      const title = typeof b.title === "string" ? b.title.trim().slice(0, 80) : ""
      const parentId = (await getProject(id)).activeSessionId
      const { branch, previous } = await createVariantBranch(id)
      const fresh = await getProject(id)
      // sessions so far belong to the line of work we just left
      await updateProject(id, { sessions: fresh.sessions.map((x) => (x.branch ? x : { ...x, branch: previous })) })
      if (parentId) noteIdeaSession(id, previous, parentId)
      const r = await startHandoff(id, { reason: "idea", ...pick, markdown, branch, ...(title ? { title } : {}) })
      noteIdeaSession(id, branch, r.sessionId)
      void rerenderAll(id)
      emit({ type: "agent.profiles.changed" })
      return { branch, sessionId: r.sessionId, handoffId: r.handoffId }
    },
  )

  // Switch to a session; if it belongs to another idea, its files come along (edits are saved first)
  app.post<{ Params: { id: string; sessionId: string } }>("/api/projects/:id/sessions/:sessionId/activate", async (req) => {
    const id = req.params.id
    const project = await getProject(id)
    const target = project.sessions.find((x) => x.id === req.params.sessionId)
    if (!target) throw httpError(404, "session not found")
    let switched = false
    let savedWork = false
    // sessions without a branch were started on whatever line of work is current: stay there
    if (target.branch && target.branch !== (await currentBranch(id))) {
      await keepIdeaSessions(id)
      ;({ switched, savedWork } = await switchToBranch(id, target.branch))
    }
    await switchSession(id, target.id)
    const branch = target.branch ?? (await currentBranch(id))
    noteIdeaSession(id, branch, target.id)
    if (switched) void rerenderAll(id)
    return { sessionId: target.id, branch, switched, savedWork }
  })

  /* ---- ideas + comparison (R22, see shared/api.md "Comparing ideas") ---- */

  // Before the files move to another idea: sessions started here without a recorded idea belong to this one, and
  // this idea remembers its open chat, so coming back brings the same chat back.
  const keepIdeaSessions = async (id: string) => {
    const p = await getProject(id)
    const cur = await currentBranch(id)
    if (p.sessions.some((x) => !x.branch)) await updateProject(id, { sessions: p.sessions.map((x) => (x.branch ? x : { ...x, branch: cur })) })
    if (p.activeSessionId && p.sessions.some((x) => x.id === p.activeSessionId && (x.branch ?? cur) === cur)) noteIdeaSession(id, cur, p.activeSessionId)
  }

  app.get<{ Params: { id: string } }>("/api/projects/:id/ideas", async (req) => listIdeas(req.params.id))

  app.patch<{ Params: { id: string; branch: string }; Body: { name?: string } | undefined }>("/api/projects/:id/ideas/:branch", async (req) =>
    renameIdea(req.params.id, req.params.branch, String(req.body?.name ?? "")),
  )

  // Open another idea: its files come back (edits here are saved first) and so does its own chat.
  app.post<{ Params: { id: string; branch: string } }>("/api/projects/:id/ideas/:branch/activate", async (req) => {
    const { id, branch } = req.params
    const before = await listIdeas(id)
    const idea = before.ideas.find((i) => i.branch === branch)
    if (!idea) throw httpError(404, "idea not found")
    if (idea.current) return { branch, sessionId: (await getProject(id)).activeSessionId, switched: false, savedWork: false }
    await keepIdeaSessions(id)
    const { switched, savedWork } = await switchToBranch(id, branch)
    const sessionId = (await listIdeas(id)).ideas.find((i) => i.branch === branch)?.sessionId ?? null
    await switchSession(id, sessionId) // null = a fresh chat on that idea
    if (switched) void rerenderAll(id)
    return { branch, sessionId, switched, savedWork }
  })

  // Read-only: two ideas (branch), saved versions (commit) or "current", side by side.
  app.get<{ Params: { id: string }; Querystring: { a?: string; b?: string } }>("/api/projects/:id/compare", async (req) => {
    const { a, b } = req.query
    if (!a || !b) throw httpError(400, "a and b are required (an idea, a version or \"current\")")
    return compareIdeas(req.params.id, a, b)
  })

  // explicit "save my work" (also used before risky operations by the UI)
  app.post<{ Params: { id: string } }>("/api/projects/:id/work-in-progress", async (req) => ({
    committed: await commitWorkInProgress(req.params.id),
  }))

  app.post<{ Params: { id: string }; Body: { message?: string } }>("/api/projects/:id/checkpoints", async (req) => ({
    commit: await saveCheckpoint(req.params.id, req.body?.message ?? "checkpoint"),
  }))

  /* ---- import trust: the project's own assistant settings (R09, server/projects/agent-config.ts) ---- */

  app.get<{ Params: { id: string } }>("/api/projects/:id/agent-config", async (req) => {
    await getProject(req.params.id) // 404 if missing
    return agentConfigStatus(req.params.id, projectDir(req.params.id), APP_SKILLS_DIR)
  })

  // The user's explicit choice; takes effect when the next agent session starts.
  app.post<{ Params: { id: string }; Body: { paths?: string[] } | undefined }>("/api/projects/:id/agent-config/enable", async (req) => {
    await getProject(req.params.id)
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((p): p is string => typeof p === "string") : undefined
    return enableAgentConfig(req.params.id, projectDir(req.params.id), APP_SKILLS_DIR, paths)
  })

  // Off again: forget the trust and move the items aside now (nothing is deleted; Enable brings them back).
  app.post<{ Params: { id: string } }>("/api/projects/:id/agent-config/disable", async (req) => {
    await getProject(req.params.id)
    revokeAgentConfig(req.params.id)
    prepareAgentConfig(req.params.id, projectDir(req.params.id), APP_SKILLS_DIR)
    return { ok: true }
  })

  // Blender part scripts that came in a build pack run only after the user allows them (server/cad/sculpt-trust.ts).
  app.post<{ Params: { id: string } }>("/api/projects/:id/sculpt-scripts/allow", async (req) => {
    await getProject(req.params.id)
    return { allowed: allowScripts(req.params.id) }
  })

  app.get<{ Params: { id: string; "*": string }; Querystring: { bg?: string } }>("/api/projects/:id/artifacts/*", async (req, reply) => {
    const rel = req.params["*"]
    let abs = resolveProjectPath(req.params.id, rel, { within: ["build", "renders"] })
    if (!existsSync(abs) || !statSync(abs).isFile()) throw httpError(404, `artifact not found: ${rel}`)
    // ?bg=clear: a part render with a transparent background, for the app's pages (server/cad/display.ts)
    if (req.query.bg === "clear" && isClearable(rel)) abs = await clearedRender(abs)
    reply.header("Content-Type", MIME[extname(abs).toLowerCase()] ?? "application/octet-stream")
    reply.header("Cache-Control", "no-cache")
    reply.header("Content-Length", statSync(abs).size)
    return reply.send(createReadStream(abs))
  })
}
