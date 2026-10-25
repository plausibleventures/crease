// The app's permission broker (R11d): a runtime with permission callbacks (Codex app-server approvals) asks through
// AdapterHost.askPermission after the app's own policy has refused what it must and allowed nothing it shouldn't.
// The UI shows a card (Allow once / Deny) and answers through POST …/agent/permission; the waiting promise resolves.
// Runtime-neutral, like questions.ts. Nothing is remembered: every request is asked once.
import { randomUUID } from "node:crypto"
import type { AgentPermissionRequest } from "../../shared/types"
import { emit } from "../events"

export interface PermissionAsk {
  title: string
  detail: string
  tool: string
}
export type PermissionOutcome = { allow: boolean; message?: string }

interface Pending {
  request: AgentPermissionRequest
  resolve: (r: PermissionOutcome, allowed: boolean | null) => void
}

const pending = new Map<string, Pending>()

export function listPermissions(projectId: string): AgentPermissionRequest[] {
  return [...pending.values()].filter((p) => p.request.projectId === projectId).map((p) => p.request)
}

/** Parks until the user answers, the turn is stopped (deny) or the session closes (deny). */
export function askPermission(
  projectId: string,
  sessionId: string,
  ask: PermissionAsk,
  opts: { signal: AbortSignal; requestId?: string; onAsked?: (request: AgentPermissionRequest) => void },
): Promise<PermissionOutcome> {
  const requestId = opts.requestId ?? randomUUID()
  const request: AgentPermissionRequest = {
    requestId,
    projectId,
    sessionId,
    title: ask.title.slice(0, 200),
    detail: ask.detail.slice(0, 4000),
    tool: ask.tool,
    createdAt: new Date().toISOString(),
  }
  return new Promise<PermissionOutcome>((resolve) => {
    const done = (r: PermissionOutcome, allowed: boolean | null) => {
      if (!pending.delete(requestId)) return
      emit({ type: "agent.permission.resolved", projectId, requestId, allowed })
      resolve(r)
    }
    pending.set(requestId, { request, resolve: done })
    if (opts.signal.aborted) return done({ allow: false, message: "The user stopped the agent." }, null)
    opts.signal.addEventListener("abort", () => done({ allow: false, message: "The user stopped the agent." }, null), { once: true })
    opts.onAsked?.(request)
    emit({ type: "agent.permission", request })
  })
}

export function answerPermission(projectId: string, requestId: string, allow: boolean) {
  const p = pending.get(requestId)
  if (!p || p.request.projectId !== projectId) {
    throw Object.assign(new Error("No pending permission request with that id (already answered or cancelled)."), { statusCode: 404 })
  }
  p.resolve(allow ? { allow: true } : { allow: false, message: "The user said no." }, allow)
}

/** Deny every pending request of a project (session closed / switched). */
export function cancelPermissions(projectId: string) {
  for (const p of [...pending.values()]) if (p.request.projectId === projectId) p.resolve({ allow: false, message: "The session was closed." }, null)
}
