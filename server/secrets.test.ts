import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"

// config.ts reads PRINTSTUDIO_HOME at import time. Never touch the user's real store or keys.
const home = mkdtempSync(join(tmpdir(), "printstudio-secrets-test-"))
process.env.PRINTSTUDIO_HOME = home
const savedEnvKey = process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_API_KEY

const KEY = "sk-ant-api03-TESTONLY-abcdefghijklmnop-wxyz"
const PRINTER_KEY = "moonraker-test-key-1234"
const settingsFile = join(home, "settings.json")
const machinesFile = join(home, "machines.json")
const storeFile = join(home, "secrets.json")

writeFileSync(settingsFile, JSON.stringify({ model: "opus", anthropicApiKey: KEY }))
writeFileSync(
  machinesFile,
  JSON.stringify({
    version: 1,
    machines: [
      {
        id: "garage-i7",
        name: "Garage i7",
        model: "Creality SPARKX i7",
        slicerProfile: "sparkx-i7",
        buildVolumeMm: [260, 260, 255],
        nozzleMm: 0.4,
        maxNozzleC: 300,
        filamentSlots: 4,
        filaments: [],
        filamentsConfirmed: false,
        tolerances: { slidingFitMm: null, pressFitMm: null, holeCompensationMm: null },
        connection: { type: "moonraker", host: "127.0.0.1", port: 7125, apiKey: PRINTER_KEY },
        enabled: true,
        isDefault: true,
      },
    ],
  }),
)

const secrets = await import("./secrets")
const config = await import("./config")
const machines = await import("./machines")
const settingsRoutes = (await import("./routes/settings")).default
const secretsRoutes = (await import("./routes/secrets")).default

/** A stand-in for Electron safeStorage: reversible, but the stored bytes don't contain the plaintext. */
const fakeCipher = {
  encrypt: (s: string) => Buffer.from("ENC:" + Buffer.from(s).toString("hex").split("").reverse().join("")),
  decrypt: (b: Buffer) => {
    const t = b.toString()
    if (!t.startsWith("ENC:")) throw new Error("bad blob")
    return Buffer.from(t.slice(4).split("").reverse().join(""), "hex").toString()
  },
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (savedEnvKey !== undefined) process.env.ANTHROPIC_API_KEY = savedEnvKey
})

describe("legacy migration", () => {
  it("moves plaintext keys into the store, verified, then strips them from the JSON", () => {
    secrets.configureSecretStore({ cipher: null })
    const r = secrets.migrateLegacySecrets()
    expect(r.migrated.sort()).toEqual(["anthropic.apiKey", "machine.garage-i7.apiKey"])
    expect(r.failed).toEqual([])
    expect(secrets.getSecret("anthropic.apiKey")).toBe(KEY)
    expect(secrets.getSecret("machine.garage-i7.apiKey")).toBe(PRINTER_KEY)
    expect(readFileSync(settingsFile, "utf8")).not.toContain(KEY)
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({ model: "opus" })
    expect(readFileSync(machinesFile, "utf8")).not.toContain(PRINTER_KEY)
    expect(statSync(storeFile).mode & 0o777).toBe(0o600)
    // idempotent
    expect(secrets.migrateLegacySecrets()).toEqual({ migrated: [], upgraded: [], failed: [] })
  })

  it("keeps the plaintext where it was when the store write fails", () => {
    writeFileSync(settingsFile, JSON.stringify({ model: "opus", anthropicApiKey: "sk-ant-api03-other-key-0000" }))
    secrets.deleteSecret("anthropic.apiKey")
    secrets.configureSecretStore({
      cipher: {
        encrypt: () => {
          throw new Error("keychain locked")
        },
        decrypt: fakeCipher.decrypt,
      },
    })
    const r = secrets.migrateLegacySecrets()
    expect(r.failed).toContain("anthropic.apiKey")
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).anthropicApiKey).toBe("sk-ant-api03-other-key-0000")
    // ...but never exposes it through Settings
    expect(JSON.stringify(config.getSettings())).not.toContain("other-key")
    // next start with a working store moves it
    secrets.configureSecretStore({ cipher: null })
    expect(secrets.migrateLegacySecrets().migrated).toEqual(["anthropic.apiKey"])
    expect(secrets.getSecret("anthropic.apiKey")).toBe("sk-ant-api03-other-key-0000")
    secrets.setSecret("anthropic.apiKey", KEY)
  })

  it("re-encrypts dev-fallback entries once a cipher is available; locked without it", () => {
    secrets.configureSecretStore({ cipher: fakeCipher })
    const r = secrets.migrateLegacySecrets()
    expect(r.upgraded.sort()).toEqual(["anthropic.apiKey", "machine.garage-i7.apiKey"])
    expect(readFileSync(storeFile, "utf8")).not.toContain(KEY)
    expect(secrets.getSecret("anthropic.apiKey")).toBe(KEY)
    expect(secrets.secretStatus("anthropic.apiKey")).toMatchObject({ set: true, source: "os-keychain", last4: "…wxyz" })

    secrets.configureSecretStore({ cipher: null }) // e.g. the browser-dev server
    expect(secrets.getSecret("anthropic.apiKey")).toBeNull()
    expect(secrets.secretStatus("anthropic.apiKey")).toMatchObject({ set: true, locked: true, last4: "…wxyz" })
    secrets.configureSecretStore({ cipher: fakeCipher })
  })
})

describe("secret store", () => {
  beforeEach(() => secrets.configureSecretStore({ cipher: fakeCipher }))

  it("replaces and deletes; status is masked", () => {
    const st = secrets.setSecret("anthropic.apiKey", "  sk-ant-api03-replaced-key-9876  ")
    expect(st).toMatchObject({ set: true, source: "os-keychain", last4: "…9876" })
    expect(JSON.stringify(st)).not.toContain("replaced")
    expect(secrets.getSecret("anthropic.apiKey")).toBe("sk-ant-api03-replaced-key-9876")
    expect(secrets.deleteSecret("anthropic.apiKey")).toEqual({ set: false, source: null })
    expect(secrets.getSecret("anthropic.apiKey")).toBeNull()
    expect(secrets.deleteSecret("anthropic.apiKey")).toEqual({ set: false, source: null }) // idempotent
  })

  it("gives short values no last4 and rejects empty or multi-line values", () => {
    expect(secrets.setSecret("machine.garage-i7.apiKey", "short").last4).toBeUndefined()
    expect(() => secrets.setSecret("anthropic.apiKey", "   ")).toThrow(/empty/)
    expect(() => secrets.setSecret("anthropic.apiKey", "a\nb")).toThrow(/one line/)
  })

  it("reports an environment key as source env", () => {
    secrets.deleteSecret("anthropic.apiKey")
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-from-env-5555"
    try {
      expect(secrets.secretStatus("anthropic.apiKey")).toEqual({ set: true, source: "env", last4: "…5555" })
      expect(secrets.anthropicApiKey()).toBe("sk-ant-api03-from-env-5555")
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })
})

describe("redaction", () => {
  beforeEach(() => {
    secrets.configureSecretStore({ cipher: fakeCipher })
    secrets.setSecret("anthropic.apiKey", KEY)
    secrets.setSecret("machine.garage-i7.apiKey", PRINTER_KEY)
  })

  it("removes known values and key-shaped tokens", () => {
    const out = secrets.redactSecrets(`env: ANTHROPIC_API_KEY=${KEY} X-Api-Key: ${PRINTER_KEY} other sk-ant-admin01-zzzzzzzzzzzz`)
    expect(out).not.toContain(KEY)
    expect(out).not.toContain(PRINTER_KEY)
    expect(out).not.toContain("zzzzzzzzzzzz")
    expect(out).toContain("[redacted]")
    expect(secrets.redactSecrets("nothing secret here")).toBe("nothing secret here")
  })

  it("redacts nested transcript messages and keeps clean ones as-is", () => {
    const msg = { type: "user", content: [{ type: "tool_result", content: `PATH=/bin\nANTHROPIC_API_KEY=${KEY}\n` }] }
    const red = secrets.redactDeep(msg)
    expect(JSON.stringify(red)).not.toContain(KEY)
    expect(red.content[0].content).toContain("ANTHROPIC_API_KEY=[redacted]")
    const clean = { type: "assistant", text: "hi" }
    expect(secrets.redactDeep(clean)).toBe(clean)
  })
})

describe("machines", () => {
  beforeEach(() => secrets.configureSecretStore({ cipher: fakeCipher }))

  it("treats connection.apiKey as write-only", () => {
    const m = machines.updateMachine("garage-i7", { connection: { type: "moonraker", host: "127.0.0.1", port: 7125, apiKey: "new-moonraker-key-4321" } })
    expect(m.connection).toMatchObject({ type: "moonraker", apiKeyStatus: { set: true, last4: "…4321" } })
    expect(JSON.stringify(m)).not.toContain("new-moonraker-key")
    expect(readFileSync(machinesFile, "utf8")).not.toContain("new-moonraker-key")
    expect(readFileSync(machinesFile, "utf8")).not.toContain("apiKeyStatus")
    expect(secrets.getSecret("machine.garage-i7.apiKey")).toBe("new-moonraker-key-4321")
    // absent = unchanged; null = remove
    machines.updateMachine("garage-i7", { connection: { type: "moonraker", host: "127.0.0.2", port: 7125 } })
    expect(secrets.getSecret("machine.garage-i7.apiKey")).toBe("new-moonraker-key-4321")
    machines.updateMachine("garage-i7", { connection: { type: "moonraker", host: "127.0.0.2", port: 7125, apiKey: null } })
    expect(secrets.getSecret("machine.garage-i7.apiKey")).toBeNull()
  })

  it("stores a new machine's key and deletes it with the machine", () => {
    const m = machines.createMachine({ name: "Shed", connection: { type: "moonraker", host: "127.0.0.3", port: 7125, apiKey: "shed-key-abcdefgh" } })
    expect(secrets.getSecret(`machine.${m.id}.apiKey`)).toBe("shed-key-abcdefgh")
    expect(JSON.stringify(machines.getMachines())).not.toContain("shed-key")
    machines.deleteMachine(m.id)
    expect(secrets.getSecret(`machine.${m.id}.apiKey`)).toBeNull()
  })
})

describe("API", () => {
  async function app() {
    const a = Fastify()
    await a.register(settingsRoutes)
    await a.register(secretsRoutes)
    return a
  }
  beforeEach(() => {
    secrets.configureSecretStore({ cipher: fakeCipher })
    secrets.setSecret("anthropic.apiKey", KEY)
  })

  it("GET /api/settings returns masked status only", async () => {
    const a = await app()
    const r = await a.inject({ method: "GET", url: "/api/settings" })
    expect(r.statusCode).toBe(200)
    expect(r.body).not.toContain(KEY)
    const s = r.json()
    expect(s.anthropicApiKey).toBeUndefined()
    expect(s.auth.anthropic).toEqual({
      method: "api-key",
      apiKey: expect.objectContaining({ set: true, source: "os-keychain", last4: "…wxyz" }),
    })
    expect(s.auth.store).toMatchObject({ backend: "os-keychain", encrypted: true })
  })

  it("PUT /api/settings refuses a key and ignores auth", async () => {
    const a = await app()
    const bad = await a.inject({ method: "PUT", url: "/api/settings", payload: { anthropicApiKey: "sk-ant-api03-nope-nope-nope" } })
    expect(bad.statusCode).toBe(400)
    expect(bad.body).not.toContain("nope-nope")
    const ok = await a.inject({ method: "PUT", url: "/api/settings", payload: { model: "sonnet", auth: { anthropic: { method: "claude-login" } } } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().auth.anthropic.method).toBe("api-key")
    expect(readFileSync(settingsFile, "utf8")).not.toMatch(/auth|anthropicApiKey/)
  })

  it("replaces and removes via /api/secrets; switches to the Claude login", async () => {
    const a = await app()
    const put = await a.inject({ method: "PUT", url: "/api/secrets/anthropic.apiKey", payload: { value: "sk-ant-api03-via-api-key-1111" } })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({ set: true, last4: "…1111" })
    expect(put.body).not.toContain("via-api")
    const list = await a.inject({ method: "GET", url: "/api/secrets" })
    expect(list.body).not.toContain("via-api")
    expect(list.json().secrets["anthropic.apiKey"].set).toBe(true)
    const del = await a.inject({ method: "DELETE", url: "/api/secrets/anthropic.apiKey" })
    expect(del.json()).toEqual({ set: false, source: null })
    const s = (await a.inject({ method: "GET", url: "/api/settings" })).json()
    expect(s.auth.anthropic.method).toBe("claude-login")
  })

  it("validates refs", async () => {
    const a = await app()
    expect((await a.inject({ method: "PUT", url: "/api/secrets/openai.apiKey", payload: { value: "x".repeat(20) } })).statusCode).toBe(400)
    expect((await a.inject({ method: "PUT", url: "/api/secrets/machine.nope.apiKey", payload: { value: "x".repeat(20) } })).statusCode).toBe(404)
    expect((await a.inject({ method: "PUT", url: "/api/secrets/anthropic.apiKey", payload: {} })).statusCode).toBe(400)
    expect(existsSync(storeFile)).toBe(true)
  })
})
