import type { FastifyInstance } from "fastify"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { getSettings, saveSettings } from "../config"
import { openscadBin } from "../tools/index"
import { ANTHROPIC_API_KEY_REF, secretStatus, secretStoreInfo } from "../secrets"
import { defaultProfile, updateProfile } from "../agent/profiles"
import { emit } from "../events"
import { aboutInfo } from "../about"
import { setTelemetryConsent, track } from "../telemetry"
import type { CodexRuntimeSettings, Settings, SettingsAuth } from "../../shared/types"

const run = promisify(execFile)
const httpErr = (statusCode: number, msg: string) => Object.assign(new Error(msg), { statusCode })

/** How the agent will authenticate, with the key's masked status (never its value). */
export function settingsAuth(): SettingsAuth {
  return {
    // R11b: the default agent profile decides (Agents screen); kept here for older clients.
    anthropic: { method: defaultProfile().auth.kind === "api-key" ? "api-key" : "claude-login", apiKey: secretStatus(ANTHROPIC_API_KEY_REF) },
    store: secretStoreInfo(),
  }
}

/** `model` mirrors the default agent profile's model (R11b: the profile is the source of truth). */
const withAuth = (s: Settings): Settings => ({ ...s, model: defaultProfile().model ?? s.model, auth: settingsAuth() })

export default async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () => withAuth(getSettings()))
  app.put<{ Body: (Partial<Settings> & { anthropicApiKey?: unknown }) | undefined }>("/api/settings", async (req) => {
    const body = { ...(req.body ?? {}) }
    // Secrets are not settings: refuse instead of silently writing plaintext (old clients sent it here).
    if ("anthropicApiKey" in body) throw httpErr(400, "API keys are set with PUT /api/secrets/anthropic.apiKey")
    delete body.auth // read-only
    if (body.units !== undefined && body.units !== "mm" && body.units !== "in") throw httpErr(400, 'units must be "mm" or "in"')
    if (body.telemetry !== undefined && body.telemetry !== null && typeof body.telemetry !== "boolean") throw httpErr(400, "telemetry must be true, false or null")
    // R11d: which Codex sign-in, and whether the partly isolated one (the user's ~/.codex) may run
    if (body.codex !== undefined) {
      const c = body.codex as Record<string, unknown> | null
      if (!c || typeof c !== "object" || Array.isArray(c)) throw httpErr(400, "codex must be an object")
      if (c.login !== undefined && c.login !== "app" && c.login !== "user") throw httpErr(400, 'codex.login must be "app" or "user"')
      if (c.allowPartialIsolation !== undefined && typeof c.allowPartialIsolation !== "boolean") throw httpErr(400, "codex.allowPartialIsolation must be true or false")
      const unknown = Object.keys(c).filter((k) => k !== "login" && k !== "allowPartialIsolation")
      if (unknown.length) throw httpErr(400, `unknown codex setting: ${unknown.join(", ")}`)
      // merged, so changing one doesn't reset the other
      body.codex = { ...(getSettings().codex ?? {}), ...(c as CodexRuntimeSettings) }
    }
    if (body.claudePath !== undefined) {
      if (typeof body.claudePath !== "string" || /[\r\n\0]/.test(body.claudePath) || body.claudePath.length > 1024) throw httpErr(400, "claudePath must be a path on one line")
      body.claudePath = body.claudePath.trim()
      if (body.claudePath && !/^(\/|~\/)/.test(body.claudePath)) throw httpErr(400, "claudePath must be an absolute path (or empty for automatic)")
    }
    // Older clients set the default model here: it goes to the default profile.
    if (body.model !== undefined) {
      const p = defaultProfile()
      if ((body.model ?? null) !== p.model) {
        updateProfile(p.id, { model: body.model ?? null }, { runtimeAvailable: () => true })
        emit({ type: "agent.profiles.changed" })
      }
    }
    const saved = withAuth(saveSettings(body))
    if (body.telemetry !== undefined) setTelemetryConsent(saved.telemetry)
    if (body.codex !== undefined) emit({ type: "agent.profiles.changed" }) // Agents screens re-check readiness
    return saved
  })
  // First-run setup closed (skipped = before Done). Sent before onboardedAt is set, so only the first time counts.
  app.post<{ Body: { skipped?: unknown } | undefined }>("/api/telemetry/onboarding", async (req) => {
    if (!getSettings().onboardedAt) track("onboarding_done", { skipped: req.body?.skipped === true })
    return { ok: true }
  })
  app.get("/api/about", async () => aboutInfo())
  app.post("/api/settings/test-openscad", async () => {
    try {
      const { stdout, stderr } = await run(openscadBin(), ["--version"])
      return { ok: true, version: (stdout || stderr).trim() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
