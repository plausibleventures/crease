// Agent profiles + the Agents screen (R11b/R11c). See shared/api.md "Agent profiles". Responses never carry key
// values: a profile's key is written straight into the secret store and only its masked status comes back.
import type { FastifyInstance } from "fastify"
import { AGENT_MODELS, type AgentConnectionResult, type AgentModelList, type AgentProfilesResponse, type ProjectAgentChoice } from "../../shared/types"
import { coordinator, RUNTIMES, setProjectProfile } from "../agent/index"
import { listFailures } from "../agent/failures"
import {
  createProfile,
  deleteProfile,
  getProfile,
  keyRefFor,
  listProfiles,
  projectModelFor,
  setDefaultProfile,
  setProfileAuth,
  snapshotOf,
  updateProfile,
} from "../agent/profiles"
import { runtimeCatalog } from "../agent/runtime/catalog"
import { emit } from "../events"
import { getProject } from "../projects/store"
import { ANTHROPIC_API_KEY_REF, deleteSecret, isProfileSecretRef, setSecret } from "../secrets"

const httpErr = (statusCode: number, msg: string) => Object.assign(new Error(msg), { statusCode })
const runtimeAvailable = (kind: string) => RUNTIMES.some((r) => r.kind === kind)
const changed = () => emit({ type: "agent.profiles.changed" })

/** A model id for `runtime`: Claude's are the switcher's aliases; other runtimes' ids are checked for shape only. */
export function validModel(runtime: string, model: unknown): model is string {
  if (typeof model !== "string" || !model) return false
  if (runtime === "claude") return AGENT_MODELS.some((m) => m.value === model)
  return /^[\w.:/[\]-]{1,100}$/.test(model)
}

function profilesResponse(): AgentProfilesResponse {
  return { ...listProfiles(), runtimes: runtimeCatalog(RUNTIMES) }
}

async function projectChoice(projectId: string): Promise<ProjectAgentChoice> {
  const project = await getProject(projectId)
  const effective = coordinator.profileFor(project)
  const own = project.agentProfileId && getProfile(project.agentProfileId) ? project.agentProfileId : null
  return { profileId: own, model: projectModelFor(project, effective.runtime), effective }
}

export default async function agentProfileRoutes(app: FastifyInstance) {
  app.get("/api/agent/profiles", async () => profilesResponse())

  app.post<{ Body: Record<string, unknown> | undefined }>("/api/agent/profiles", async (req) => {
    const body = { ...(req.body ?? {}) }
    // A runtime that only takes API keys (the API connection) starts on its own key ref, not a sign-in it can't use.
    const info = runtimeCatalog(RUNTIMES).find((r) => r.kind === body.runtime)
    if (body.auth === undefined && info && !info.authKinds.includes("subscription")) body.auth = { kind: "api-key" }
    const p = createProfile(body, { runtimeAvailable })
    changed()
    return p
  })

  app.put<{ Params: { id: string }; Body: Record<string, unknown> | undefined }>("/api/agent/profiles/:id", async (req) => {
    const p = updateProfile(req.params.id, req.body ?? {}, { runtimeAvailable })
    changed()
    return p
  })

  app.delete<{ Params: { id: string } }>("/api/agent/profiles/:id", async (req) => {
    const p = getProfile(req.params.id)
    deleteProfile(req.params.id)
    // Its own key goes with it (a shared ref like anthropic.apiKey stays).
    if (p?.auth.kind === "api-key" && isProfileSecretRef(p.auth.credentialRef)) deleteSecret(p.auth.credentialRef)
    changed()
    return { ok: true }
  })

  app.put<{ Body: { profileId?: unknown } | undefined }>("/api/agent/default-profile", async (req) => {
    const id = req.body?.profileId
    if (typeof id !== "string") throw httpErr(400, "profileId is required")
    setDefaultProfile(id)
    changed()
    return profilesResponse()
  })

  // The profile's API key: stored in the secret store under the profile's ref (read back + verified), and the
  // profile switched to it. The value never comes back.
  app.put<{ Params: { id: string }; Body: { value?: unknown } | undefined }>("/api/agent/profiles/:id/key", async (req) => {
    const p = getProfile(req.params.id)
    if (!p) throw httpErr(404, `profile not found: ${req.params.id}`)
    const value = req.body?.value
    if (typeof value !== "string") throw httpErr(400, "body must be {value: string}")
    const ref = keyRefFor(p)
    setSecret(ref, value)
    const v = setProfileAuth(p.id, { kind: "api-key", credentialRef: ref })
    changed()
    return v
  })

  app.delete<{ Params: { id: string } }>("/api/agent/profiles/:id/key", async (req) => {
    const p = getProfile(req.params.id)
    if (!p) throw httpErr(404, `profile not found: ${req.params.id}`)
    if (p.auth.kind === "api-key" && (isProfileSecretRef(p.auth.credentialRef) || p.auth.credentialRef === ANTHROPIC_API_KEY_REF)) deleteSecret(p.auth.credentialRef)
    // A runtime that only takes keys (the API connection) keeps its key ref, now empty; others go back to their sign-in.
    const keyOnly = !runtimeCatalog(RUNTIMES).find((r) => r.kind === p.runtime)?.authKinds.includes("subscription")
    const v = setProfileAuth(p.id, keyOnly ? { kind: "api-key", credentialRef: keyRefFor(p) } : { kind: "subscription" })
    changed()
    return v
  })

  // Test connection: install + sign-in/key checks, no paid turn. {message: true} = "Send a test message" (costs a little).
  app.post<{ Params: { id: string }; Body: { message?: unknown } | undefined }>("/api/agent/profiles/:id/test", async (req): Promise<AgentConnectionResult> => {
    const p = getProfile(req.params.id)
    if (!p) throw httpErr(404, `profile not found: ${req.params.id}`)
    const rt = RUNTIMES.find((r) => r.kind === p.runtime)
    if (!rt) return { ok: false, steps: [], summary: "This designer isn't available in this version of Crease yet." }
    const snap = snapshotOf(p, "default")
    if (req.body?.message === true) {
      if (!rt.testMessage) return { ok: false, steps: [], summary: "This designer can't send a test message yet." }
      return rt.testMessage(snap)
    }
    if (rt.checkConnection) return rt.checkConnection(snap)
    const probe = await rt.probe()
    const ok = probe.installed && probe.auth.status !== "missing"
    return {
      ok,
      steps: [
        { label: "Installed", ok: probe.installed, detail: probe.version ?? undefined },
        { label: "Signed in", ok: probe.auth.status === "ok" ? true : probe.auth.status === "missing" ? false : null },
      ],
      summary: ok ? "Ready." : (probe.detail ?? "Not ready yet."),
      fix: probe.login?.fix ?? null,
    }
  })

  // R11f: models the profile's own endpoint lists (free; runtimes without per-profile discovery use the probe's list).
  app.get<{ Params: { id: string } }>("/api/agent/profiles/:id/models", async (req): Promise<AgentModelList> => {
    const p = getProfile(req.params.id)
    if (!p) throw httpErr(404, `profile not found: ${req.params.id}`)
    const rt = RUNTIMES.find((r) => r.kind === p.runtime)
    if (!rt) return { models: [], defaultModel: null, error: "This designer isn't available in this version of Crease yet." }
    if (rt.listModels) return rt.listModels(snapshotOf(p, "default"))
    const probe = await rt.probe()
    return { models: probe.models, defaultModel: probe.defaultModel ?? null }
  })

  app.get<{ Querystring: { profileId?: string; limit?: string } }>("/api/agent/failures", async (req) =>
    listFailures({ limit: Math.min(100, Math.max(1, Number(req.query.limit) || 20)), ...(req.query.profileId ? { profileId: req.query.profileId } : {}) })
  )

  app.get<{ Params: { id: string } }>("/api/projects/:id/agent/profile", async (req) => projectChoice(req.params.id))

  app.post<{ Params: { id: string }; Body: { profileId?: unknown; model?: unknown } | undefined }>("/api/projects/:id/agent/profile", async (req) => {
    const { profileId = null, model = null } = req.body ?? {}
    if (profileId !== null && (typeof profileId !== "string" || !getProfile(profileId))) throw httpErr(400, "unknown profile")
    const runtime = (profileId ? getProfile(profileId as string) : null)?.runtime ?? coordinator.profileFor({ ...(await getProject(req.params.id)), agentProfileId: null }).runtime
    if (model !== null && !validModel(runtime, model)) throw httpErr(400, "unknown model")
    await setProjectProfile(req.params.id, profileId as string | null, model as string | null)
    changed()
    return projectChoice(req.params.id)
  })
}
