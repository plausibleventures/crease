// R11b/c: agent profiles (schema, migration from settings + the key ref, keys never in plaintext JSON), per-project
// override resolution, the frozen per-run snapshot, budget stop, and the profile/key routes. No Claude, no tokens.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentProfileSnapshot, Project, ServerEvent } from "../../shared/types"

const home = mkdtempSync(join(tmpdir(), "printstudio-profiles-test-"))
process.env.PRINTSTUDIO_HOME = home
const savedEnvKey = process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_API_KEY

const KEY = "sk-ant-api03-PROFILETEST-abcdefghijkl-9876"
const KEY2 = "sk-ant-api03-SECONDKEY-zyxwvutsrqpo-5555"
writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "sonnet" }))

const secrets = await import("../secrets")
const profiles = await import("./profiles")
const { SessionCoordinator } = await import("./coordinator")
const { FakeRuntime } = await import("./runtime/fake")
const { deps } = await import("./deps")
const { onEvent } = await import("../events")
const { ToolRegistry, STUDIO_TOOLS } = await import("./registry")
const { readEvents } = await import("./transcript")
const { listFailures } = await import("./failures")
const { runtimeCatalog } = await import("./runtime/catalog")

const fakeCipher = {
  encrypt: (s: string) => Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ 0x5a)),
  decrypt: (b: Buffer) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString("utf8"),
}

const file = () => profiles.PROFILES_FILE()
const resetProfiles = () => {
  rmSync(file(), { force: true })
  profiles.resetProfilesCache()
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (savedEnvKey !== undefined) process.env.ANTHROPIC_API_KEY = savedEnvKey
})

describe("migration from settings.model + anthropic.apiKey", () => {
  beforeEach(() => {
    secrets.configureSecretStore({ cipher: fakeCipher })
    resetProfiles()
  })

  it("imports a stored key as a ref (never the value), keeps the model, verifies and records the migration", () => {
    secrets.setSecret("anthropic.apiKey", KEY)
    const r = profiles.migrateProfiles()
    expect(r).toEqual({ migrated: true, verified: true })
    const raw = readFileSync(file(), "utf8")
    expect(raw).not.toContain(KEY)
    expect(raw).not.toContain("PROFILETEST")
    const j = JSON.parse(raw)
    expect(j.defaultProfileId).toBe("claude")
    expect(j.profiles[0]).toMatchObject({ id: "claude", name: "Claude", runtime: "claude", model: "sonnet", auth: { kind: "api-key", credentialRef: "anthropic.apiKey" }, policy: "design-sandbox" })
    expect(j.migration).toMatchObject({ from: "settings", model: "sonnet", credential: { ref: "anthropic.apiKey", source: "os-keychain" }, verified: true })
    expect(JSON.stringify(j.migration)).not.toMatch(/sk-ant|last4|…/)
    // idempotent
    expect(profiles.migrateProfiles()).toEqual({ migrated: false, verified: true })
    // the snapshot carries the ref; the key resolves only through the secret store
    const snap = profiles.resolveProfile({})
    expect(snap).toMatchObject({ profileId: "claude", runtime: "claude", model: "sonnet", source: "default" })
    expect(JSON.stringify(snap)).not.toContain(KEY)
    expect(profiles.profileApiKey(snap)).toBe(KEY)
    expect(profiles.billingOf(snap)).toBe("api")
  })

  it("a new install without a key starts on an API key (INVENTORY B1), verified with no key yet", () => {
    secrets.deleteSecret("anthropic.apiKey")
    expect(profiles.migrateProfiles()).toEqual({ migrated: true, verified: true })
    expect(profiles.defaultProfile().auth).toEqual({ kind: "api-key", credentialRef: "anthropic.apiKey" })
    expect(profiles.listProfiles().migration).toMatchObject({ credential: null, verified: true })
    expect(profiles.billingOf(profiles.resolveProfile({}))).toBe("api")
  })

  it("an install set up before profiles, without a key, keeps the user's own Claude Code login", () => {
    secrets.deleteSecret("anthropic.apiKey")
    writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "sonnet", onboardedAt: "2026-10-01T00:00:00.000Z" }))
    try {
      profiles.migrateProfiles()
      expect(profiles.defaultProfile().auth).toEqual({ kind: "subscription" })
      expect(profiles.billingOf(profiles.resolveProfile({}))).toBe("plan")
    } finally {
      writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "sonnet" }))
    }
  })

  it("an unreadable profiles file falls back to the settings-derived profile", () => {
    writeFileSync(file(), "{nope")
    profiles.resetProfilesCache()
    expect(profiles.defaultProfile()).toMatchObject({ id: "claude", runtime: "claude", model: "sonnet" })
  })
})

describe("profile schema", () => {
  beforeEach(() => {
    secrets.configureSecretStore({ cipher: fakeCipher })
    secrets.deleteSecret("anthropic.apiKey")
    resetProfiles()
    profiles.migrateProfiles()
  })
  const avail = { runtimeAvailable: (k: string) => k === "claude" }

  it("validates fields and rejects anything key-shaped", () => {
    expect(() => profiles.createProfile({ name: "x", runtime: "claude", apiKey: KEY }, avail)).toThrow(/API keys aren't profile fields/)
    expect(() => profiles.createProfile({ name: "x", runtime: "claude", token: "t" }, avail)).toThrow(/API keys/)
    expect(() => profiles.createProfile({ name: "x", runtime: "claude", budget: { maxUsdPerRun: -1 } }, avail)).toThrow(/budget/)
    expect(() => profiles.createProfile({ name: "x", runtime: "claude", effort: "turbo" }, avail)).toThrow(/effort/)
    expect(() => profiles.createProfile({ name: "x", runtime: "claude", binaryPath: "relative/claude" }, avail)).toThrow(/absolute/)
    expect(() => profiles.createProfile({ name: "x", runtime: "codex" }, avail)).toThrow(/isn't available/)
    expect(() => profiles.createProfile({ name: "x", runtime: "claude", policy: "yolo" }, avail)).toThrow(/policy/)
    expect(() => profiles.createProfile({ name: "x", runtime: "claude", auth: { kind: "api-key", credentialRef: "machine.m1.apiKey" } }, avail)).not.toThrow() // ref replaced by its own
    const p = profiles.createProfile({ name: "Claude (work)", runtime: "claude", model: "haiku", effort: "low", budget: { maxUsdPerRun: 0.5 }, auth: { kind: "api-key" } }, avail)
    expect(p).toMatchObject({ name: "Claude (work)", model: "haiku", effort: "low", budget: { maxUsdPerRun: 0.5 }, auth: { kind: "api-key", credentialRef: `profile.${p.id}.apiKey` }, isDefault: false })
    expect(p.credential).toMatchObject({ set: false })
  })

  it("can't delete the default; the default can move", () => {
    const p = profiles.createProfile({ name: "Second", runtime: "claude" }, avail)
    expect(() => profiles.deleteProfile("claude")).toThrow(/default/)
    profiles.setDefaultProfile(p.id)
    expect(profiles.defaultProfile().id).toBe(p.id)
    profiles.deleteProfile("claude")
    expect(profiles.listProfiles().profiles.map((x) => x.id)).toEqual([p.id])
  })

  it("lists registered runtimes as available and known ones as coming soon", () => {
    const rt = new FakeRuntime()
    const cat = runtimeCatalog([rt])
    expect(cat[0]).toMatchObject({ kind: "fake", available: true })
    expect(cat.find((c) => c.kind === "codex")).toMatchObject({ available: false, label: "Codex" })
    expect(cat.find((c) => c.kind === "claude")).toMatchObject({ available: false })
  })
})

describe("per-project override resolution", () => {
  beforeEach(() => {
    secrets.configureSecretStore({ cipher: fakeCipher })
    resetProfiles()
    profiles.migrateProfiles()
  })
  it("project profile > default; the project's model applies only to the runtime it was picked for", () => {
    const other = profiles.createProfile({ name: "Budget Claude", runtime: "claude", model: "haiku" }, { runtimeAvailable: () => true })
    const fake = profiles.createProfile({ name: "Fake", runtime: "fakert", model: "f-1" }, { runtimeAvailable: () => true })
    expect(profiles.resolveProfile({})).toMatchObject({ profileId: "claude", model: "sonnet", source: "default" })
    // a legacy project model pick (no runtime recorded) = Claude's
    expect(profiles.resolveProfile({ agentModel: "opus" })).toMatchObject({ profileId: "claude", model: "opus" })
    expect(profiles.resolveProfile({ agentProfileId: other.id })).toMatchObject({ profileId: other.id, model: "haiku", source: "project" })
    expect(profiles.resolveProfile({ agentProfileId: other.id, agentModel: "opus", agentModelRuntime: "claude" })).toMatchObject({ model: "opus" })
    // a Claude model pick doesn't leak into another runtime
    expect(profiles.resolveProfile({ agentProfileId: fake.id, agentModel: "opus" })).toMatchObject({ runtime: "fakert", model: "f-1" })
    // a deleted override falls back to the default
    profiles.deleteProfile(other.id)
    expect(profiles.resolveProfile({ agentProfileId: other.id })).toMatchObject({ profileId: "claude", source: "default" })
  })
})

describe("coordinator: frozen profile snapshot and budget", () => {
  const P = "prof-test"
  let root = ""
  let project: Project
  let runtime: InstanceType<typeof FakeRuntime>
  let coord: InstanceType<typeof SessionCoordinator>
  let ws: ServerEvent[] = []
  let stop: () => void
  const realDeps = { ...deps }
  let profileId = ""

  beforeEach(() => {
    secrets.configureSecretStore({ cipher: fakeCipher })
    resetProfiles()
    profiles.migrateProfiles()
    profileId = profiles.createProfile({ name: "Fake designer", runtime: "fake", model: "fake-1", budget: { maxUsdPerRun: 0.1 } }, { runtimeAvailable: () => true }).id
    root = mkdtempSync(join(tmpdir(), "prof-"))
    mkdirSync(join(root, "parts"), { recursive: true })
    writeFileSync(join(root, "parts", "main.scad"), "cube(20);")
    project = {
      id: P,
      name: "Profiles",
      createdAt: "",
      printer: "",
      engine: "openscad",
      tags: [],
      parts: [{ id: "main", file: "parts/main.scad", qty: 1, colors: [] }],
      activeSessionId: null,
      sessions: [],
      source: null,
      agentProfileId: profileId,
    } as unknown as Project
    Object.assign(deps, {
      projectDir: () => root,
      getProject: async () => project,
      updateProject: async (_id: string, patch: Partial<Project>) => (project = { ...project, ...patch }),
      readAssembly: async () => ({ assembly: null }),
    })
    runtime = new FakeRuntime()
    coord = new SessionCoordinator({
      runtimes: [runtime],
      resolveProfile: profiles.resolveProfile,
      tools: new ToolRegistry([...STUDIO_TOOLS]),
      prepare: async () => ({ instructions: "brief", policy: {}, model: null, notices: [] }),
    })
    ws = []
    stop = onEvent((e) => ws.push(e))
  })
  afterEach(() => {
    stop()
    coord.dispose()
    Object.assign(deps, realDeps)
    rmSync(root, { recursive: true, force: true })
  })

  const usage = (usd: number) => ({ type: "usage.updated" as const, usage: { tokens: null, billedUsd: null, estimatedApiUsd: usd, billing: "plan" as const, subscription: null, final: false } })

  it("freezes the effective profile at run start; edits apply from the next run", async () => {
    const { sessionId } = await coord.sendMessage(P, "make a cube", [], [], "make a cube")
    const a = runtime.last
    const frozen = a.ctx.profile as AgentProfileSnapshot
    expect(frozen).toMatchObject({ profileId, name: "Fake designer", runtime: "fake", model: "fake-1", budget: { maxUsdPerRun: 0.1 }, source: "project" })
    // edit the profile mid-run: the running session/run keep the snapshot
    profiles.updateProfile(profileId, { name: "Renamed", model: "fake-2", budget: { maxUsdPerRun: 5 } }, { runtimeAvailable: () => true })
    expect(a.ctx.profile).toEqual(frozen)
    const started = readEvents(P, sessionId!).find((e) => e.event.type === "run.started")!
    expect(started.event).toMatchObject({ profile: { id: profileId, name: "Fake designer", runtime: "fake", budgetUsd: 0.1 }, model: "fake-1" })
    // the old budget still applies to this run
    a.host.emit(usage(0.2), { persist: false })
    expect(a.interrupts).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    // next run: same process (same sign-in/runtime), new model switched in place, new budget
    await coord.sendMessage(P, "again", [], [], "again")
    expect(runtime.adapters.length).toBe(1)
    expect(a.models).toEqual(["fake-2"])
    const runs = readEvents(P, sessionId!).filter((e) => e.event.type === "run.started")
    expect(runs[1].event).toMatchObject({ profile: { name: "Renamed", budgetUsd: 5 }, model: "fake-2" })
  })

  it("restarts the runtime process when the sign-in changes between runs", async () => {
    await coord.sendMessage(P, "one", [], [], "one")
    const a = runtime.last
    a.host.emit({ type: "run.completed", result: { subtype: "success", isError: false, text: "", durationMs: 1, turns: 1, usage: null } }, { itemId: "e1" })
    profiles.updateProfile(profileId, { effort: "high" }, { runtimeAvailable: () => true })
    await coord.sendMessage(P, "two", [], [], "two")
    expect(a.closed).toBe(true)
    expect(runtime.adapters.length).toBe(2)
    expect(runtime.last.ctx.profile.effort).toBe("high")
    expect(runtime.last.ctx.resume).toBe(project.activeSessionId) // same runtime: the conversation resumes
  })

  it("stops a run over its budget with a clear message and logs it", async () => {
    const { sessionId } = await coord.sendMessage(P, "big job", [], [], "big job")
    const a = runtime.last
    a.host.emit(usage(0.05), { persist: false })
    expect(a.interrupts).toBe(0)
    a.host.emit(usage(0.12), { persist: false })
    a.host.emit(usage(0.3), { persist: false }) // once per run
    expect(a.interrupts).toBe(1)
    const envs = readEvents(P, sessionId!)
    const notice = envs.find((e) => e.event.type === "notice" && e.event.code === "budget.exceeded")
    expect(notice?.event).toMatchObject({ level: "error" })
    expect((notice?.event as { text: string }).text).toMatch(/Stopped: this request reached its \$0\.10 budget.*raise the budget for “Fake designer” in Agents/)
    expect(types(envs)).toContain("run.interrupted")
    expect(listFailures({ profileId })[0]).toMatchObject({ kind: "budget", projectId: P, projectName: "Profiles", profileName: "Fake designer" })
    expect(ws.some((e) => e.type === "agent.failure")).toBe(true)
  })

  it("a failed run is logged with its profile", async () => {
    await coord.sendMessage(P, "x", [], [], "x")
    runtime.last.die("process crashed")
    expect(listFailures({ limit: 1 })[0]).toMatchObject({ kind: "failed", error: "process crashed", profileId })
  })

  it("an unavailable runtime fails with a plain message", async () => {
    const ghost = profiles.createProfile({ name: "Ghost", runtime: "ghost" }, { runtimeAvailable: () => true })
    project = { ...project, agentProfileId: ghost.id }
    await expect(coord.sendMessage(P, "x", [], [], "x")).rejects.toThrow(/isn't available in this version/)
  })

  it("a conversation held by another runtime starts fresh with a notice", async () => {
    project = { ...project, activeSessionId: "old-claude", sessions: [{ id: "old-claude", title: "t", forkedFrom: null, runtime: "claude" }] }
    const { sessionId } = await coord.sendMessage(P, "x", [], [], "x")
    expect(sessionId).not.toBe("old-claude")
    expect(runtime.last.ctx.resume).toBeNull()
    expect(readEvents(P, sessionId!).some((e) => e.event.type === "notice" && /new conversation with Fake designer/.test((e.event as { text: string }).text))).toBe(true)
    expect(project.sessions.find((s) => s.id === sessionId)?.runtime).toBe("fake")
  })
})

const types = (envs: { event: { type: string } }[]) => envs.map((e) => e.event.type)

describe("profile routes", () => {
  let a: ReturnType<typeof Fastify>
  beforeEach(async () => {
    secrets.configureSecretStore({ cipher: fakeCipher })
    secrets.deleteSecret("anthropic.apiKey")
    resetProfiles()
    profiles.migrateProfiles()
    const { default: routes } = await import("../routes/agent-profiles")
    a = Fastify()
    await a.register(routes)
  })

  it("sets a profile's key in the secret store only; responses and the profiles file never hold it", async () => {
    const created = (await a.inject({ method: "POST", url: "/api/agent/profiles", payload: { name: "Work key", runtime: "claude", model: "haiku" } })).json()
    expect(created.auth).toEqual({ kind: "subscription" })
    const bad = await a.inject({ method: "PUT", url: `/api/agent/profiles/${created.id}`, payload: { apiKey: KEY2 } })
    expect(bad.statusCode).toBe(400)
    expect(bad.body).not.toContain("SECONDKEY")
    const put = await a.inject({ method: "PUT", url: `/api/agent/profiles/${created.id}/key`, payload: { value: KEY2 } })
    expect(put.statusCode).toBe(200)
    expect(put.body).not.toContain("SECONDKEY")
    expect(put.json()).toMatchObject({ auth: { kind: "api-key", credentialRef: `profile.${created.id}.apiKey` }, credential: { set: true, last4: "…5555", source: "os-keychain" } })
    expect(readFileSync(file(), "utf8")).not.toContain("SECONDKEY")
    expect(secrets.getSecret(`profile.${created.id}.apiKey`)).toBe(KEY2)
    const list = await a.inject({ method: "GET", url: "/api/agent/profiles" })
    expect(list.body).not.toContain("SECONDKEY")
    expect(list.json().runtimes.find((r: { kind: string }) => r.kind === "claude")).toMatchObject({ available: true })
    expect(list.json().runtimes.find((r: { kind: string }) => r.kind === "codex")).toMatchObject({ available: true }) // R11d
    expect(list.json().runtimes.find((r: { kind: string }) => r.kind === "grok")).toMatchObject({ available: true }) // R11e
    expect(list.json().runtimes.find((r: { kind: string }) => r.kind === "api")).toMatchObject({ available: true, authKinds: ["api-key"] }) // R11f
    // removing the key switches back to the sign-in and deletes the secret
    const del = await a.inject({ method: "DELETE", url: `/api/agent/profiles/${created.id}/key` })
    expect(del.json().auth).toEqual({ kind: "subscription" })
    expect(secrets.getSecret(`profile.${created.id}.apiKey`)).toBeNull()
    // default selection
    const d = await a.inject({ method: "PUT", url: "/api/agent/default-profile", payload: { profileId: created.id } })
    expect(d.json().defaultProfileId).toBe(created.id)
    expect(existsSync(file() + ".tmp")).toBe(false)
  })

  it("R11f API connection: starts on its own key ref; protocol and endpoint validated; removing the key keeps it a key profile; models route", async () => {
    const created = (await a.inject({ method: "POST", url: "/api/agent/profiles", payload: { name: "API connection", runtime: "api" } })).json()
    expect(created.auth).toEqual({ kind: "api-key", credentialRef: `profile.${created.id}.apiKey` })
    expect(created.apiProtocol).toBeNull()
    expect((await a.inject({ method: "PUT", url: `/api/agent/profiles/${created.id}`, payload: { apiProtocol: "grpc" } })).statusCode).toBe(400)
    expect((await a.inject({ method: "PUT", url: `/api/agent/profiles/${created.id}`, payload: { endpointRef: "file:///etc" } })).statusCode).toBe(400)
    const ok = await a.inject({ method: "PUT", url: `/api/agent/profiles/${created.id}`, payload: { apiProtocol: "openai-chat", endpointRef: "http://localhost:1/v1", model: "llama3.2" } })
    expect(ok.json()).toMatchObject({ apiProtocol: "openai-chat", endpointRef: "http://localhost:1/v1", model: "llama3.2" })
    expect(JSON.parse(readFileSync(file(), "utf8")).profiles.find((p: { id: string }) => p.id === created.id).apiProtocol).toBe("openai-chat")
    await a.inject({ method: "PUT", url: `/api/agent/profiles/${created.id}/key`, payload: { value: KEY2 } })
    const del = await a.inject({ method: "DELETE", url: `/api/agent/profiles/${created.id}/key` })
    expect(del.json().auth).toEqual({ kind: "api-key", credentialRef: `profile.${created.id}.apiKey` })
    expect(secrets.getSecret(`profile.${created.id}.apiKey`)).toBeNull()
    // nothing listens on localhost:1: an explained empty list, no throw
    const models = (await a.inject({ method: "GET", url: `/api/agent/profiles/${created.id}/models` })).json()
    expect(models).toMatchObject({ models: [], defaultModel: null })
    expect(models.error).toMatch(/Couldn't reach/)
  })
})
