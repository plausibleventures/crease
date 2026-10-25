// Agent profiles (R11b): which designer (runtime) runs, with what model, how it signs in, budget and policy.
//
// Storage: <STUDIO_HOME>/agent-profiles.json {version: 1, defaultProfileId, profiles, migration}. Non-secret only:
// an API-key profile holds a credentialRef into the secret store (secrets.ts), never the key. Every write is checked
// against the known secret values before it touches disk.
//
// Migration (first read on an install from before R11b): settings.model + the "anthropic.apiKey" ref (or
// ANTHROPIC_API_KEY in the environment) become the default "Claude" profile. Without a key, a new install starts on
// an API-key profile (INVENTORY B1); an install onboarded before profiles keeps the Claude Code login it used. The file is written, read back and
// compared, and the credential ref re-checked, before it's relied on; until then (or if that fails) the same profile
// is derived in memory from the legacy settings and the migration is retried on the next read. The migration record
// keeps the old model and the key's ref/source, never the key.
//
// Resolution: a project's own profile (.studio/state.json agentProfileId), else the default; the project's model
// pick applies when it was made for the same runtime. The coordinator freezes the result (a snapshot) per run.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { randomUUID } from "node:crypto"
import type {
  ApiProtocol,
  AgentBilling,
  AgentEffort,
  AgentProfile,
  AgentProfileAuth,
  AgentProfileMigration,
  AgentProfileSnapshot,
  AgentProfileView,
  Project,
} from "../../shared/types"
import { getSettings, STUDIO_HOME } from "../config"
import { ANTHROPIC_API_KEY_REF, getSecret, isKnownSecretRef, profileSecretRef, redactSecrets, secretStatus } from "../secrets"

export const PROFILES_FILE = () => join(STUDIO_HOME, "agent-profiles.json")
export const DEFAULT_CLAUDE_PROFILE_ID = "claude"
export const EFFORTS: AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]
export const MAX_BUDGET_USD = 1000
export const API_PROTOCOLS: ApiProtocol[] = ["anthropic", "openai-chat"]

interface StoreFile {
  version: 1
  defaultProfileId: string
  profiles: AgentProfile[]
  migration: AgentProfileMigration | null
}

const httpErr = (statusCode: number, msg: string) => Object.assign(new Error(msg), { statusCode })

// ---------------------------------------------------------------------------------------------
// Validation: only whitelisted, non-secret fields are ever stored.
// ---------------------------------------------------------------------------------------------

function str(v: unknown, field: string, max: number): string | null {
  if (v === null || v === undefined || v === "") return null
  if (typeof v !== "string") throw httpErr(400, `${field} must be a string`)
  const t = v.trim()
  if (t.length > max) throw httpErr(400, `${field} is too long`)
  if (/[\r\n\0]/.test(t)) throw httpErr(400, `${field} must be one line`)
  return t || null
}

function cleanAuth(v: unknown, fallback: AgentProfileAuth): AgentProfileAuth {
  if (v === undefined) return fallback
  if (!v || typeof v !== "object") throw httpErr(400, "auth must be {kind}")
  const a = v as { kind?: unknown; credentialRef?: unknown }
  if (a.kind === "subscription") return { kind: "subscription" }
  if (a.kind === "api-key") {
    const ref = typeof a.credentialRef === "string" ? a.credentialRef : fallback.kind === "api-key" ? fallback.credentialRef : ""
    if (!ref || !isKnownSecretRef(ref) || ref.startsWith("machine.")) throw httpErr(400, "auth.credentialRef must be a secret ref (set the key with PUT /api/agent/profiles/:id/key)")
    return { kind: "api-key", credentialRef: ref }
  }
  throw httpErr(400, 'auth.kind must be "subscription" or "api-key"')
}

function cleanBudget(v: unknown, fallback: AgentProfile["budget"]): AgentProfile["budget"] {
  if (v === undefined) return fallback
  if (v === null) return { maxUsdPerRun: null }
  const n = (v as { maxUsdPerRun?: unknown }).maxUsdPerRun
  if (n === null || n === undefined || n === "") return { maxUsdPerRun: null }
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > MAX_BUDGET_USD) throw httpErr(400, `budget.maxUsdPerRun must be between 0 and ${MAX_BUDGET_USD} dollars, or null`)
  return { maxUsdPerRun: Math.round(n * 100) / 100 }
}

/** Patch → a full, clean profile. Unknown fields (including any `apiKey`) are rejected. */
export function cleanProfile(input: Record<string, unknown>, base: AgentProfile): AgentProfile {
  const allowed = new Set(["name", "runtime", "model", "auth", "endpointRef", "binaryPath", "apiProtocol", "effort", "budget", "policy"])
  for (const k of Object.keys(input)) {
    if (/key|secret|token|password/i.test(k)) throw httpErr(400, "API keys aren't profile fields: set them with PUT /api/agent/profiles/:id/key")
    if (!allowed.has(k) && !["id", "createdAt", "updatedAt", "credential", "isDefault"].includes(k)) throw httpErr(400, `unknown profile field: ${k}`)
  }
  const name = input.name === undefined ? base.name : str(input.name, "name", 60)
  if (!name) throw httpErr(400, "name is required")
  const runtime = input.runtime === undefined ? base.runtime : str(input.runtime, "runtime", 40)
  if (!runtime || !/^[a-z0-9-]+$/.test(runtime)) throw httpErr(400, "runtime is required")
  const effort = input.effort === undefined ? (base.effort ?? null) : input.effort === null || input.effort === "" ? null : (input.effort as AgentEffort)
  if (effort !== null && !EFFORTS.includes(effort)) throw httpErr(400, `effort must be one of ${EFFORTS.join(", ")}`)
  const binaryPath = input.binaryPath === undefined ? (base.binaryPath ?? null) : str(input.binaryPath, "binaryPath", 1024)
  if (binaryPath && !isAbsolute(binaryPath)) throw httpErr(400, "binaryPath must be an absolute path")
  const policy = input.policy === undefined ? base.policy : input.policy
  if (policy !== "design-sandbox") throw httpErr(400, 'policy must be "design-sandbox"')
  const apiProtocol = input.apiProtocol === undefined ? (base.apiProtocol ?? null) : input.apiProtocol === null || input.apiProtocol === "" ? null : input.apiProtocol
  if (apiProtocol !== null && !API_PROTOCOLS.includes(apiProtocol as ApiProtocol)) throw httpErr(400, `apiProtocol must be one of ${API_PROTOCOLS.join(", ")}, or null`)
  const endpointRef = input.endpointRef === undefined ? (base.endpointRef ?? null) : str(input.endpointRef, "endpointRef", 1024)
  if (endpointRef && !/^https?:\/\/[^\s/]+/i.test(endpointRef)) throw httpErr(400, "endpointRef must be an http(s) URL")
  return {
    id: base.id,
    name,
    runtime,
    model: input.model === undefined ? base.model : str(input.model, "model", 100),
    auth: cleanAuth(input.auth, base.auth),
    endpointRef,
    binaryPath,
    apiProtocol: apiProtocol as ApiProtocol | null,
    effort,
    budget: cleanBudget(input.budget, base.budget),
    policy,
    createdAt: base.createdAt,
    updatedAt: new Date().toISOString(),
  }
}

/** Exactly the stored shape (drops anything else a caller or an old file carried). */
function storedShape(p: AgentProfile): AgentProfile {
  return {
    id: p.id,
    name: p.name,
    runtime: p.runtime,
    model: p.model ?? null,
    auth: p.auth?.kind === "api-key" ? { kind: "api-key", credentialRef: p.auth.credentialRef } : { kind: "subscription" },
    endpointRef: p.endpointRef ?? null,
    binaryPath: p.binaryPath ?? null,
    apiProtocol: p.apiProtocol && API_PROTOCOLS.includes(p.apiProtocol) ? p.apiProtocol : null,
    effort: p.effort ?? null,
    budget: { maxUsdPerRun: typeof p.budget?.maxUsdPerRun === "number" ? p.budget.maxUsdPerRun : null },
    policy: "design-sandbox",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

// ---------------------------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------------------------

let cache: { mtimeMs: number; store: StoreFile } | null = null

function parse(text: string): StoreFile | null {
  try {
    const j = JSON.parse(text)
    if (!j || j.version !== 1 || !Array.isArray(j.profiles) || !j.profiles.length) return null
    const profiles = (j.profiles as AgentProfile[]).filter((p) => p && typeof p.id === "string" && typeof p.runtime === "string").map(storedShape)
    if (!profiles.length) return null
    const defaultProfileId = profiles.some((p) => p.id === j.defaultProfileId) ? j.defaultProfileId : profiles[0].id
    return { version: 1, defaultProfileId, profiles, migration: j.migration ?? null }
  } catch {
    return null
  }
}

function serialize(store: StoreFile): string {
  const json = JSON.stringify({ ...store, profiles: store.profiles.map(storedShape) }, null, 2) + "\n"
  // Defence in depth: a known secret value (or anything key-shaped) must never reach this file.
  if (redactSecrets(json) !== json) throw new Error("refusing to write agent-profiles.json: it would contain a secret")
  return json
}

function writeStore(store: StoreFile) {
  const f = PROFILES_FILE()
  const tmp = f + ".tmp"
  writeFileSync(tmp, serialize(store))
  renameSync(tmp, f)
  cache = null
}

// ---------------------------------------------------------------------------------------------
// Migration from settings.model + anthropic.apiKey
// ---------------------------------------------------------------------------------------------

/** The Claude profile today's settings describe (what the app did before profiles existed). */
function legacyStore(): StoreFile {
  let model: string | null = "opus"
  let onboarded = false
  try {
    const s = getSettings()
    model = s.model ?? null
    onboarded = !!s.onboardedAt
  } catch {
    /* defaults */
  }
  const key = secretStatus(ANTHROPIC_API_KEY_REF) // stored (any source) or ANTHROPIC_API_KEY in the environment
  const now = new Date().toISOString()
  // New installs start on an API key (INVENTORY B1: Agent SDK apps use API keys; the user may switch to their own,
  // already signed-in Claude Code). An install that was set up before profiles existed keeps the login it used.
  const useLogin = !key.set && onboarded
  const profile: AgentProfile = {
    id: DEFAULT_CLAUDE_PROFILE_ID,
    name: "Claude",
    runtime: "claude",
    model,
    auth: useLogin ? { kind: "subscription" } : { kind: "api-key", credentialRef: ANTHROPIC_API_KEY_REF },
    endpointRef: null,
    binaryPath: null,
    apiProtocol: null,
    effort: null,
    budget: { maxUsdPerRun: null },
    policy: "design-sandbox",
    createdAt: now,
    updatedAt: now,
  }
  return {
    version: 1,
    defaultProfileId: profile.id,
    profiles: [profile],
    migration: {
      at: now,
      from: "settings",
      model,
      credential: key.set ? { ref: ANTHROPIC_API_KEY_REF, source: key.source } : null,
      profileId: profile.id,
      verified: false,
    },
  }
}

export interface ProfileMigrationReport {
  migrated: boolean
  verified: boolean
  error?: string
}

let lastMigration: ProfileMigrationReport | null = null

/** Write the legacy-derived profile, read it back, verify, then mark it verified. Idempotent. */
export function migrateProfiles(): ProfileMigrationReport {
  if (existsSync(PROFILES_FILE()) && parse(readFileSync(PROFILES_FILE(), "utf8"))) return { migrated: false, verified: true }
  const store = legacyStore()
  try {
    writeStore(store)
    const back = parse(readFileSync(PROFILES_FILE(), "utf8"))
    const same = back && JSON.stringify(back.profiles) === JSON.stringify(store.profiles) && back.defaultProfileId === store.defaultProfileId
    const p = store.profiles[0]
    // A migrated key must still resolve; a new install's API-key profile has no key yet (the user adds it).
    const credOk = p.auth.kind !== "api-key" || !store.migration?.credential || secretStatus(p.auth.credentialRef).set
    if (!same || !credOk) throw new Error(!same ? "profiles file didn't read back identically" : "the API key ref no longer resolves")
    store.migration = { ...store.migration!, verified: true }
    writeStore(store)
    lastMigration = { migrated: true, verified: true }
  } catch (e) {
    // Don't rely on a file we couldn't verify: remove it so the next read derives from settings and retries.
    try {
      if (existsSync(PROFILES_FILE())) renameSync(PROFILES_FILE(), PROFILES_FILE() + ".failed")
    } catch {
      /* ignore */
    }
    cache = null
    lastMigration = { migrated: false, verified: false, error: (e as Error).message }
    console.error(`[profiles] migration not verified: ${(e as Error).message}`)
  }
  return lastMigration
}

function readStore(): StoreFile {
  const f = PROFILES_FILE()
  if (!existsSync(f)) migrateProfiles()
  if (!existsSync(f)) return legacyStore() // unverified: behave exactly like before profiles, retry next time
  const mtimeMs = statSync(f).mtimeMs
  if (cache && cache.mtimeMs === mtimeMs) return structuredClone(cache.store)
  const store = parse(readFileSync(f, "utf8"))
  if (!store) {
    console.error("[profiles] agent-profiles.json is unreadable; using the settings-derived Claude profile")
    return legacyStore()
  }
  cache = { mtimeMs, store }
  return structuredClone(store)
}

/** For tests: forget the cached file. */
export function resetProfilesCache() {
  cache = null
  lastMigration = null
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

export function credentialStatus(p: Pick<AgentProfile, "auth">) {
  return p.auth.kind === "api-key" ? secretStatus(p.auth.credentialRef) : null
}

function view(p: AgentProfile, defaultId: string): AgentProfileView {
  return { ...p, credential: credentialStatus(p), isDefault: p.id === defaultId }
}

export function listProfiles(): { defaultProfileId: string; profiles: AgentProfileView[]; migration: AgentProfileMigration | null } {
  const s = readStore()
  return { defaultProfileId: s.defaultProfileId, profiles: s.profiles.map((p) => view(p, s.defaultProfileId)), migration: s.migration }
}

export function getProfile(id: string): AgentProfile | null {
  return readStore().profiles.find((p) => p.id === id) ?? null
}

export function defaultProfile(): AgentProfile {
  const s = readStore()
  return s.profiles.find((p) => p.id === s.defaultProfileId) ?? s.profiles[0]
}

function mutate<T>(fn: (s: StoreFile) => T): T {
  const s = readStore()
  const r = fn(s)
  writeStore(s)
  return r
}

export function createProfile(input: Record<string, unknown>, opts: { runtimeAvailable: (kind: string) => boolean }): AgentProfileView {
  const now = new Date().toISOString()
  const base: AgentProfile = {
    id: `p-${randomUUID().slice(0, 8)}`,
    name: "",
    runtime: "claude",
    model: null,
    auth: { kind: "subscription" },
    endpointRef: null,
    binaryPath: null,
    apiProtocol: null,
    effort: null,
    budget: { maxUsdPerRun: null },
    policy: "design-sandbox",
    createdAt: now,
    updatedAt: now,
  }
  // A new API-key profile's key goes under its own ref; it's set with PUT …/key.
  const auth = (input.auth as { kind?: string } | undefined)?.kind === "api-key" ? { kind: "api-key", credentialRef: profileSecretRef(base.id) } : input.auth
  const p = cleanProfile({ ...input, ...(auth ? { auth } : {}) }, base)
  if (!opts.runtimeAvailable(p.runtime)) throw httpErr(400, `"${p.runtime}" isn't available in this version of Crease yet`)
  return mutate((s) => {
    s.profiles.push(p)
    return view(p, s.defaultProfileId)
  })
}

export function updateProfile(id: string, patch: Record<string, unknown>, opts: { runtimeAvailable: (kind: string) => boolean }): AgentProfileView {
  return mutate((s) => {
    const i = s.profiles.findIndex((p) => p.id === id)
    if (i < 0) throw httpErr(404, `profile not found: ${id}`)
    const next = cleanProfile(patch, s.profiles[i])
    if (next.runtime !== s.profiles[i].runtime && !opts.runtimeAvailable(next.runtime)) throw httpErr(400, `"${next.runtime}" isn't available yet`)
    s.profiles[i] = next
    return view(next, s.defaultProfileId)
  })
}

export function deleteProfile(id: string): void {
  mutate((s) => {
    if (!s.profiles.some((p) => p.id === id)) throw httpErr(404, `profile not found: ${id}`)
    if (s.defaultProfileId === id) throw httpErr(400, "This is the default designer. Pick another default first.")
    s.profiles = s.profiles.filter((p) => p.id !== id)
  })
}

export function setDefaultProfile(id: string): void {
  mutate((s) => {
    if (!s.profiles.some((p) => p.id === id)) throw httpErr(404, `profile not found: ${id}`)
    s.defaultProfileId = id
  })
}

/**
 * The ref a profile's API key is stored under (assigned on first key). The migrated Claude profile keeps
 * "anthropic.apiKey" so Settings and the environment fallback keep working.
 */
export function keyRefFor(p: AgentProfile): string {
  if (p.auth.kind === "api-key") return p.auth.credentialRef
  return p.id === DEFAULT_CLAUDE_PROFILE_ID && p.runtime === "claude" ? ANTHROPIC_API_KEY_REF : profileSecretRef(p.id)
}

/** Switch a profile's sign-in (the key itself is set/removed by the caller through secrets.ts). */
export function setProfileAuth(id: string, auth: AgentProfileAuth): AgentProfileView {
  return mutate((s) => {
    const p = s.profiles.find((x) => x.id === id)
    if (!p) throw httpErr(404, `profile not found: ${id}`)
    p.auth = auth
    p.updatedAt = new Date().toISOString()
    return view(p, s.defaultProfileId)
  })
}

/**
 * The legacy key routes (PUT/DELETE /api/secrets/anthropic.apiKey) keep their old meaning: with a key the migrated
 * Claude profile uses it; without one, profiles on that ref go back to the Claude sign-in. True when anything changed.
 */
export function syncProfilesWithAnthropicKey(hasKey: boolean): boolean {
  if (!existsSync(PROFILES_FILE())) return false
  return mutate((s) => {
    let n = 0
    for (const p of s.profiles) {
      if (p.runtime !== "claude") continue
      const onRef = p.auth.kind === "api-key" && p.auth.credentialRef === ANTHROPIC_API_KEY_REF
      if (hasKey && p.auth.kind === "subscription" && keyRefFor(p) === ANTHROPIC_API_KEY_REF) {
        p.auth = { kind: "api-key", credentialRef: ANTHROPIC_API_KEY_REF }
        n++
      } else if (!hasKey && onRef && !process.env.ANTHROPIC_API_KEY) {
        p.auth = { kind: "subscription" }
        n++
      }
    }
    return n > 0
  })
}

// ---------------------------------------------------------------------------------------------
// Resolution + snapshots
// ---------------------------------------------------------------------------------------------

/** The model a project uses under `runtime`: its own pick when made for that runtime, else null. */
export function projectModelFor(project: Pick<Project, "agentModel" | "agentModelRuntime">, runtime: string): string | null {
  if (!project.agentModel) return null
  return (project.agentModelRuntime ?? "claude") === runtime ? project.agentModel : null
}

export function snapshotOf(p: AgentProfile, source: AgentProfileSnapshot["source"], model?: string | null): AgentProfileSnapshot {
  return {
    profileId: p.id,
    name: p.name,
    runtime: p.runtime,
    model: model ?? p.model ?? null,
    auth: structuredClone(p.auth),
    endpointRef: p.endpointRef ?? null,
    binaryPath: p.binaryPath ?? null,
    apiProtocol: p.apiProtocol ?? null,
    effort: p.effort ?? null,
    budget: { maxUsdPerRun: p.budget.maxUsdPerRun },
    policy: p.policy,
    source,
    frozenAt: new Date().toISOString(),
  }
}

/** The effective profile for a project, frozen now. */
export function resolveProfile(project: Pick<Project, "agentProfileId" | "agentModel" | "agentModelRuntime">): AgentProfileSnapshot {
  const own = project.agentProfileId ? getProfile(project.agentProfileId) : null
  const p = own ?? defaultProfile()
  return snapshotOf(p, own ? "project" : existsSync(PROFILES_FILE()) ? "default" : "legacy", projectModelFor(project, p.runtime))
}

/** The API key a snapshot signs in with (only for the code that passes it to the runtime). */
export function profileApiKey(p: Pick<AgentProfileSnapshot, "auth">): string | null {
  if (p.auth.kind !== "api-key") return null
  const ref = p.auth.credentialRef
  return getSecret(ref) ?? (ref === ANTHROPIC_API_KEY_REF ? process.env.ANTHROPIC_API_KEY || null : null)
}

export const billingOf = (p: Pick<AgentProfileSnapshot, "auth">): AgentBilling => (p.auth.kind === "api-key" ? "api" : "plan")

/** What changing requires a fresh runtime process (vs. the next run picking it up). */
export function sessionFingerprint(p: AgentProfileSnapshot): string {
  return JSON.stringify([p.profileId, p.runtime, p.auth, p.endpointRef, p.binaryPath, p.apiProtocol ?? null, p.effort, p.policy])
}
