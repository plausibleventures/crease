// Usage reports: only allow-listed events/params/values leave the machine, nothing without consent, opt-out deletes the id.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { AgentEventEnvelope, AgentEvent, ServerEvent } from "../shared/types"
import { SCHEMA, Telemetry, modelFamily, sanitize, telemetryAvailable, type GaPayload } from "./telemetry"

const home = mkdtempSync(join(tmpdir(), "ps-telemetry-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))
let n = 0
const SECRET_TEXT = "make me a box for /Users/ann/secret.scad on 10.0.0.24 sk-ant-abc123"

function make(consent: boolean | null) {
  const sent: GaPayload[] = []
  let clock = 1_000_000
  const t = new Telemetry({
    file: join(home, `telemetry-${++n}.json`),
    consent,
    available: true,
    appVersion: () => "0.1.0",
    isPractice: (id) => id === "practice-printer",
    send: async (_url, body) => void sent.push(structuredClone(body)),
    now: () => (clock += 1000),
  })
  return { t, sent }
}

const env = (runId: string, event: AgentEvent, runtime = "app"): ServerEvent =>
  ({ type: "agent.event", schemaVersion: 1, eventId: "1", seq: 1, ts: "", projectId: "p-secret", sessionId: "s", runId, itemId: null, revision: null, runtime, event }) as ServerEvent & AgentEventEnvelope

// Representative events, many carrying free text (prompts, names, paths, errors, hosts) that must never be sent.
const EVENTS: ServerEvent[] = [
  env("r1", { type: "run.started", input: { text: SECRET_TEXT }, model: "claude-sonnet-4-5", profile: { id: "x", name: "Ann's key", runtime: "claude", budgetUsd: 2 } }),
  env("r1", { type: "message.delta", role: "assistant", kind: "text", delta: SECRET_TEXT }),
  env("r1", { type: "tool.started", name: "Write", input: { path: "/Users/ann/x.scad" } }),
  env("r1", { type: "run.completed", result: { subtype: "success", isError: false, text: SECRET_TEXT, durationMs: 95_000, turns: 3, usage: null } }),
  env("r2", { type: "run.started", input: { text: SECRET_TEXT }, model: "gpt-5-codex", profile: { id: "y", name: "Codex", runtime: "codex", budgetUsd: null } }),
  env("r2", { type: "run.failed", error: SECRET_TEXT }),
  env("r3", { type: "run.started", input: { text: "hi" }, model: null, profile: { id: "z", name: "Mine", runtime: "my-custom-runtime", budgetUsd: null } }),
  env("r3", { type: "run.interrupted" }),
  { type: "agent.failure", failure: { ts: "", projectId: "p", projectName: "Secret project", sessionId: "s", runId: "r2", profileId: "y", profileName: "Codex", runtime: "codex", kind: "auth", error: SECRET_TEXT } },
  { type: "agent.status", projectId: "p", running: false, sessionId: "s", costUsd: 1.2345 },
  { type: "render.done", projectId: "p", result: { partId: "secret-part", stlUrl: "/api/x.stl", images: [], stats: null, cached: false, durationMs: 2_300, error: SECRET_TEXT } },
  { type: "render.done", projectId: "p", result: { partId: "p", stlUrl: "", images: [], stats: null, cached: true, durationMs: 1 } },
  { type: "check.done", projectId: "p", report: { partId: "p", createdAt: "", summary: "warn", items: [{ id: "a", severity: "warn", message: SECRET_TEXT }, { id: "b", severity: "pass", message: "ok" }] } as never },
  { type: "print.request", request: { requestId: "q1", projectId: "p", gcodeName: "secret.gcode", estimatedTimeS: 60, filamentG: 3, origin: "user", machineId: "practice-printer" } },
  { type: "print.request", request: { requestId: "q1", projectId: "p", gcodeName: "secret.gcode", estimatedTimeS: 60, filamentG: 3, origin: "user", machineId: "practice-printer" } },
  { type: "print.request.resolved", requestId: "q1", approved: true },
  { type: "print.finished", printId: "pr", projectId: "p", state: "error", message: SECRET_TEXT, practice: false },
  { type: "printer.status", status: { state: "printing", message: SECRET_TEXT } as never },
  { type: "project.changed", projectId: "p", paths: ["/Users/ann/secret.scad"] },
]

function allowed(name: string, key: string, value: unknown) {
  if (key === "engagement_time_msec") return value === 1
  if (key === "session_id") return typeof value === "number"
  const a = SCHEMA[name]?.[key]
  return !!a && typeof value === "string" && (a instanceof RegExp ? a.test(value) : a.includes(value))
}

describe("telemetry", () => {
  it("sends only allow-listed events, params and values", async () => {
    const { t, sent } = make(true)
    for (const e of EVENTS) t.handle(e)
    t.track("project_created", { from_starter: false, name: "Secret project" } as never)
    t.track("nope" as never, { x: SECRET_TEXT })
    await t.flush()
    expect(sent.length).toBe(1)
    const body = sent[0]
    expect(Object.keys(body).sort()).toEqual(["client_id", "events", "user_properties"])
    expect(body.client_id).toMatch(/^[0-9a-f-]{36}$/)
    for (const [k, v] of Object.entries(body.user_properties!)) expect(allowed("app_open", k, v.value) || v.value === "unknown").toBe(true)
    for (const ev of body.events) {
      expect(Object.keys(SCHEMA)).toContain(ev.name)
      for (const [k, v] of Object.entries(ev.params)) expect(allowed(ev.name, k, v), `${ev.name}.${k}=${v}`).toBe(true)
    }
    const json = JSON.stringify(body)
    for (const bad of ["secret", "Ann", "Users", "10.0.0.24", "sk-ant", "p-secret", "1.2345", "make me"]) expect(json).not.toContain(bad)

    const strip = body.events.map(({ name, params }) => {
      const { engagement_time_msec, session_id, ...rest } = params
      expect(engagement_time_msec).toBe(1)
      expect(session_id).toBe(t.sessionId)
      return { name, ...rest }
    })
    expect(strip).toEqual([
      { name: "app_open", app_version: "0.1.0", os: expect.any(String), arch: expect.any(String) },
      { name: "design_turn", runtime: "claude", model: "sonnet", outcome: "done", duration: "1-3m" },
      { name: "design_turn", runtime: "codex", model: "gpt-5", outcome: "failed", duration: "<10s" },
      { name: "design_turn", runtime: "other", model: "default", outcome: "stopped", duration: "<10s" },
      { name: "agent_failure", runtime: "codex", kind: "auth" },
      { name: "render", ok: "false", time: "1-5s" },
      { name: "check", result: "warn", issues: "1" },
      { name: "print_request", approved: "true", practice: "true" },
      { name: "print_finished", state: "error", practice: "false" },
      { name: "project_created", from_starter: "false" },
    ])
  })

  it("batches at most 25 events per request", async () => {
    const { t, sent } = make(true)
    for (let i = 0; i < 60; i++) t.track("build_pack_exported")
    await t.flush()
    expect(sent.map((b) => b.events.length)).toEqual([25, 25, 11])
    expect(t.pending.length).toBe(0)
  })

  it("sends nothing until the user says yes", async () => {
    for (const consent of [null, false]) {
      const { t, sent } = make(consent)
      for (const e of EVENTS) t.handle(e)
      t.track("build_pack_exported")
      await t.flush()
      expect(sent).toEqual([])
      expect(t.clientId()).toBeNull()
    }
  })

  it("opting out deletes the install id and drops the queue; opting in again makes a new one", async () => {
    const { t, sent } = make(true)
    const file = (t as unknown as { o: { file: string } }).o.file
    const first = JSON.parse(readFileSync(file, "utf8")).clientId
    t.track("build_pack_exported")
    t.setConsent(false)
    expect(existsSync(file)).toBe(false)
    await t.flush()
    expect(sent).toEqual([])
    t.setConsent(true)
    const second = JSON.parse(readFileSync(file, "utf8")).clientId
    expect(second).not.toBe(first)
    await t.flush()
    expect(sent[0].client_id).toBe(second)
    expect(sent[0].events.map((e) => e.name)).toEqual(["app_open"])
  })

  it("swallows send failures", async () => {
    const t = new Telemetry({ file: join(home, "fail.json"), consent: true, available: true, appVersion: () => "0.1.0", send: () => Promise.reject(new Error("offline")) })
    await expect(t.flush()).resolves.toBeUndefined()
  })

  it("is off without a secret, under tests, and with CREASE_TELEMETRY=0", () => {
    expect(telemetryAvailable({}, "")).toBe(false)
    expect(telemetryAvailable({ VITEST: "true" }, "s")).toBe(false)
    expect(telemetryAvailable({ NODE_ENV: "test" }, "s")).toBe(false)
    expect(telemetryAvailable({ CREASE_TELEMETRY: "0" }, "s")).toBe(false)
    expect(telemetryAvailable({}, "s")).toBe(true)
    expect(telemetryAvailable(process.env)).toBe(false)
  })

  it("keeps model families and drops anything else", () => {
    expect(modelFamily("claude-opus-4-1")).toBe("opus")
    expect(modelFamily("o3-mini")).toBe("o-series")
    expect(modelFamily("grok-4")).toBe("grok")
    expect(modelFamily("my-local-llama")).toBe("other")
    expect(sanitize("render", { ok: true, time: "1-5s", path: "/x" })).toEqual({ ok: "true", time: "1-5s" })
    expect(sanitize("render", { time: SECRET_TEXT })).toEqual({})
    expect(sanitize("app_open", { app_version: SECRET_TEXT })).toEqual({})
    expect(sanitize("__proto__", {})).toBeNull()
  })
})
