// PUT /api/settings {codex}: the Agents screen's Codex sign-in choice and the partial-isolation opt-in (R11d).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ServerEvent } from "../../shared/types"

const home = mkdtempSync(join(tmpdir(), "ps-settings-"))
process.env.PRINTSTUDIO_HOME = home

let app: FastifyInstance
const events: ServerEvent[] = []

beforeAll(async () => {
  app = Fastify()
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => reply.status(err.statusCode ?? 500).send({ error: err.message }))
  await app.register((await import("./settings")).default)
  ;(await import("../events")).onEvent((e) => events.push(e))
})
afterAll(async () => {
  await app?.close()
  rmSync(home, { recursive: true, force: true })
})

const put = (payload: unknown) => app.inject({ method: "PUT", url: "/api/settings", payload: payload as object })

describe("codex settings", () => {
  it("saves the sign-in choice and the partial-isolation opt-in separately (one change keeps the other)", async () => {
    expect((await put({ codex: { login: "user" } })).json().codex).toEqual({ login: "user" })
    expect(events.some((e) => e.type === "agent.profiles.changed")).toBe(true)
    expect((await put({ codex: { allowPartialIsolation: true } })).json().codex).toEqual({ login: "user", allowPartialIsolation: true })
    expect((await put({ codex: { login: "app" } })).json().codex).toEqual({ login: "app", allowPartialIsolation: true })
    const { codexLogin, codexSettings } = await import("../agent/runtime/codex/config")
    expect(codexLogin(codexSettings())).toBe("app")
  })

  it("refuses values it doesn't understand", async () => {
    expect((await put({ codex: { login: "root" } })).statusCode).toBe(400)
    expect((await put({ codex: { allowPartialIsolation: "yes" } })).statusCode).toBe(400)
    expect((await put({ codex: { sandbox: "off" } })).statusCode).toBe(400)
    expect((await put({ codex: null })).statusCode).toBe(400)
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json().codex).toEqual({ login: "app", allowPartialIsolation: true })
  })
})

describe("retired uiMode (U2: no Beginner/Maker modes)", () => {
  it("ignores an old stored value, drops it on the next save, and accepts an old client's PUT", async () => {
    const { SETTINGS_FILE } = await import("../config")
    writeFileSync(SETTINGS_FILE, JSON.stringify({ ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")), uiMode: "maker" }))
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json()).not.toHaveProperty("uiMode")
    const r = await put({ uiMode: "beginner", model: "sonnet" })
    expect(r.statusCode).toBe(200)
    expect(r.json()).not.toHaveProperty("uiMode")
    expect(r.json().model).toBe("sonnet")
    expect(JSON.parse(readFileSync(SETTINGS_FILE, "utf8"))).not.toHaveProperty("uiMode")
  })
})

describe("GET /api/about", () => {
  it("names the app, version, licence and data folder; no repository in package.json means no links", async () => {
    const r = (await app.inject({ method: "GET", url: "/api/about" })).json()
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"))
    expect(r).toMatchObject({ name: "Crease", version: pkg.version, license: "Apache-2.0", dataDir: home })
    expect(r.os.platform).toBeTruthy()
    if (!pkg.repository) expect([r.repoUrl, r.issueUrl]).toEqual([null, null])
  })

  it("turns package.json repository forms into a browsable URL (GitHub ones get an issue link)", async () => {
    const { repoUrlOf, issueUrlOf } = await import("../about")
    for (const r of ["github:me/printstudio", "me/printstudio", "git+https://github.com/me/printstudio.git", "git@github.com:me/printstudio.git", { url: "https://github.com/me/printstudio" }])
      expect(repoUrlOf(r)).toBe("https://github.com/me/printstudio")
    expect(repoUrlOf(undefined)).toBeNull()
    expect(repoUrlOf("file:../x")).toBeNull()
    expect(issueUrlOf("https://github.com/me/printstudio")).toBe("https://github.com/me/printstudio/issues/new")
    expect(issueUrlOf("https://gitlab.com/me/printstudio")).toBeNull()
  })
})

describe("telemetry setting", () => {
  it("is unset until answered, accepts true/false/null only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json().telemetry ?? null).toBeNull()
    expect((await put({ telemetry: "yes" })).statusCode).toBe(400)
    expect((await put({ telemetry: true })).json().telemetry).toBe(true)
    expect((await put({ telemetry: false })).json().telemetry).toBe(false)
  })
})
