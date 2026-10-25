// Opt-in, anonymous usage reports (Settings.telemetry; README "Privacy"). Off until the user says yes. Server events
// are mapped to a few coarse events (SCHEMA below) and sent in batches to Google Analytics 4 (Measurement Protocol).
// Every param is checked against SCHEMA before it is queued, so free text (prompts, names, paths, errors, hosts) can't
// leave the machine even if a mapping is wrong. Sending never blocks and never surfaces an error.
import { randomUUID } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { arch, platform } from "node:os"
import { join } from "node:path"
import type { ServerEvent } from "../shared/types"

export const MEASUREMENT_ID = "G-G1M0RQN93G"
// GA4 Measurement Protocol key for the "Crease app" stream. It ships inside every build, so it isn't a secret in
// any real sense: it only lets a caller add events to that stream. CREASE_TELEMETRY_SECRET overrides it (forks:
// point it at your own stream, or set CREASE_TELEMETRY=0 to turn reporting off).
export const API_SECRET = process.env.CREASE_TELEMETRY_SECRET ?? "tOXKesH1SuyN7K_Xgfhagw"
const ENDPOINT = "https://www.google-analytics.com/mp/collect"

const FLUSH_MS = 30_000
const BATCH = 25 // GA4 Measurement Protocol limit per request
const QUEUE_CAP = 200
const SEND_TIMEOUT_MS = 3_000

/** Sending is possible at all: a secret is set, not under tests, and not turned off with CREASE_TELEMETRY=0. */
export function telemetryAvailable(env: NodeJS.ProcessEnv = process.env, secret = API_SECRET): boolean {
  if (!secret) return false
  if (env.CREASE_TELEMETRY === "0") return false
  if (env.NODE_ENV === "test" || env.VITEST) return false
  return true
}

// ---- What may be sent: every event, every param, every value ----

const BOOL = ["true", "false"] as const
const DURATION = ["<10s", "10-30s", "30s-1m", "1-3m", "3-10m", "10m+"] as const
const MS = ["<1s", "1-5s", "5-15s", "15-60s", "60s+"] as const
const COUNT = ["0", "1", "2-5", "6+"] as const
const RUNTIMES = ["claude", "codex", "grok", "api", "other"] as const
const MODELS = ["opus", "sonnet", "haiku", "fable", "claude", "gpt-5", "gpt-4", "o-series", "grok", "gemini", "default", "other"] as const
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,20})?$/

type Allowed = readonly string[] | RegExp
export const SCHEMA: Record<string, Record<string, Allowed>> = {
  app_open: { app_version: VERSION, os: ["mac", "windows", "linux", "other"], arch: ["arm64", "x64", "other"] },
  onboarding_done: { skipped: BOOL },
  design_turn: { runtime: RUNTIMES, model: MODELS, outcome: ["done", "failed", "stopped"], duration: DURATION },
  agent_failure: { runtime: RUNTIMES, kind: ["failed", "budget", "auth"] },
  render: { ok: BOOL, time: MS },
  check: { result: ["pass", "warn", "fail"], issues: COUNT },
  slice: { ok: BOOL, multicolor: BOOL },
  print_request: { approved: BOOL, practice: BOOL },
  print_finished: { state: ["complete", "cancelled", "error"], practice: BOOL },
  print_rated: { result: ["great", "ok", "problem", "failed"], issue: ["didnt_stick", "stringing", "warping", "layer_shift", "spaghetti", "rough_top", "wrong_size", "broke", "other", "none"] },
  project_created: { from_starter: BOOL },
  build_pack_exported: {},
}
export type TelemetryName = keyof typeof SCHEMA
export type TelemetryParams = Record<string, string | boolean | number | null | undefined>

const bool = (v: unknown) => (v ? "true" : "false")
const bucket = <T extends readonly string[]>(n: number, edges: number[], names: T): T[number] => {
  const i = edges.findIndex((e) => n < e)
  return names[i < 0 ? names.length - 1 : i]
}
export const durationBucket = (ms: number) => bucket(ms, [10e3, 30e3, 60e3, 180e3, 600e3], DURATION)
export const msBucket = (ms: number) => bucket(ms, [1e3, 5e3, 15e3, 60e3], MS)
export const countBucket = (n: number) => bucket(n, [1, 2, 6], COUNT)

export function runtimeOf(r: string | null | undefined): (typeof RUNTIMES)[number] {
  return (RUNTIMES as readonly string[]).includes(r ?? "") ? (r as (typeof RUNTIMES)[number]) : "other"
}

/** The model's family only ("claude-sonnet-4-5" -> "sonnet"), never the full id. */
export function modelFamily(model: string | null | undefined): (typeof MODELS)[number] {
  const m = (model ?? "").toLowerCase()
  if (!m) return "default"
  for (const f of ["opus", "sonnet", "haiku", "fable", "grok", "gemini", "gpt-5", "gpt-4"] as const) if (m.includes(f)) return f
  if (/(^|[^a-z])o[1-9]/.test(m)) return "o-series"
  if (m.includes("claude")) return "claude"
  return "other"
}

/** Keeps only SCHEMA params with allowed values; null for an unknown event. */
export function sanitize(name: string, params: TelemetryParams): Record<string, string> | null {
  const spec = Object.prototype.hasOwnProperty.call(SCHEMA, name) ? SCHEMA[name] : null
  if (!spec) return null
  const out: Record<string, string> = {}
  for (const [k, raw] of Object.entries(params)) {
    const allowed = Object.prototype.hasOwnProperty.call(spec, k) ? spec[k] : null
    if (!allowed || raw == null) continue
    const v = typeof raw === "boolean" ? bool(raw) : String(raw)
    if (allowed instanceof RegExp ? allowed.test(v) : allowed.includes(v)) out[k] = v
  }
  return out
}

export interface GaEvent {
  name: string
  params: Record<string, string | number>
}
export interface GaPayload {
  client_id: string
  user_properties?: Record<string, { value: string }>
  events: GaEvent[]
}
export type Sender = (url: string, body: GaPayload) => Promise<void>

const fetchSender: Sender = async (url, body) => {
  await fetch(url, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
}

const osName = (p: string) => (p === "darwin" ? "mac" : p === "win32" ? "windows" : p === "linux" ? "linux" : "other")
const archName = (a: string) => (a === "arm64" || a === "x64" ? a : "other")

export interface TelemetryOptions {
  /** <STUDIO_HOME>/telemetry.json: the random install id, created on opt-in and deleted on opt-out. */
  file: string
  consent: boolean | null | undefined
  /** False = nothing is queued or sent (no secret, tests, CREASE_TELEMETRY=0). The consent file still follows consent. */
  available: boolean
  appVersion: () => string
  /** The print request's printer is the built-in practice printer. */
  isPractice?: (machineId: string | undefined) => boolean
  send?: Sender
  now?: () => number
}

export class Telemetry {
  readonly sessionId: number
  private consent: boolean | null
  private queue: GaEvent[] = []
  private runs = new Map<string, { at: number; runtime: string; model: string }>()
  private requests = new Map<string, boolean>() // print requestId -> practice
  private opened = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly send: Sender
  private readonly now: () => number

  constructor(private readonly o: TelemetryOptions) {
    this.send = o.send ?? fetchSender
    this.now = o.now ?? Date.now
    this.sessionId = Math.floor(this.now() / 1000)
    this.consent = o.consent ?? null
    this.setConsent(this.consent)
  }

  /** Follows Settings.telemetry. Yes: an install id exists (new if there was none) and app_open is sent once per
   *  launch. No: the id file is deleted and anything queued is dropped. */
  setConsent(v: boolean | null | undefined) {
    this.consent = v ?? null
    if (v === true) {
      this.clientId()
      if (!this.opened) {
        this.opened = true
        this.track("app_open", { app_version: this.o.appVersion(), os: osName(platform()), arch: archName(arch()) })
      }
    } else if (v === false) {
      this.queue = []
      this.opened = false
      rmSync(this.o.file, { force: true })
    }
  }

  /** The install id, created when missing (only while consent is yes). */
  clientId(): string | null {
    if (this.consent !== true) return null
    try {
      const id = (JSON.parse(readFileSync(this.o.file, "utf8")) as { clientId?: unknown }).clientId
      if (typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) return id
    } catch {
      /* missing or unreadable: make a new one */
    }
    const id = randomUUID()
    try {
      writeFileSync(this.o.file, JSON.stringify({ clientId: id, createdAt: new Date(this.now()).toISOString() }, null, 2) + "\n")
    } catch {
      /* not fatal */
    }
    return id
  }

  get pending(): readonly GaEvent[] {
    return this.queue
  }

  track(name: TelemetryName, params: TelemetryParams = {}) {
    if (this.consent !== true || !this.o.available) return
    const clean = sanitize(name, params)
    if (!clean) return
    this.queue.push({ name, params: { ...clean, engagement_time_msec: 1, session_id: this.sessionId } })
    if (this.queue.length > QUEUE_CAP) this.queue.splice(0, this.queue.length - QUEUE_CAP)
  }

  /** Maps one server event to a telemetry event (most map to none). */
  handle(e: ServerEvent) {
    switch (e.type) {
      case "agent.event": {
        const ev = e.event
        if (!e.runId) return
        if (ev.type === "run.started") {
          this.runs.set(e.runId, { at: this.now(), runtime: ev.profile?.runtime ?? e.runtime, model: ev.model ?? "" })
          if (this.runs.size > 50) this.runs.delete(this.runs.keys().next().value!)
          return
        }
        if (ev.type !== "run.completed" && ev.type !== "run.failed" && ev.type !== "run.interrupted") return
        const run = this.runs.get(e.runId)
        if (!run) return
        this.runs.delete(e.runId)
        const ms = ev.result?.durationMs ?? this.now() - run.at
        const outcome = ev.type === "run.completed" ? (ev.result.isError ? "failed" : "done") : ev.type === "run.failed" ? "failed" : "stopped"
        return this.track("design_turn", { runtime: runtimeOf(run.runtime), model: modelFamily(run.model), outcome, duration: durationBucket(ms) })
      }
      case "agent.failure":
        return this.track("agent_failure", { runtime: runtimeOf(e.failure.runtime), kind: e.failure.kind })
      case "render.done":
        if (e.result.cached) return
        return this.track("render", { ok: !e.result.error, time: msBucket(e.result.durationMs) })
      case "check.done": {
        const issues = e.report.items.filter((i) => i.severity === "warn" || i.severity === "fail").length
        return this.track("check", { result: e.report.summary === "info" ? "pass" : e.report.summary, issues: countBucket(issues) })
      }
      case "print.request":
        if (!this.requests.has(e.request.requestId)) {
          let practice = false
          try {
            practice = !!this.o.isPractice?.(e.request.machineId)
          } catch {
            /* unknown machine */
          }
          this.requests.set(e.request.requestId, practice)
          if (this.requests.size > 50) this.requests.delete(this.requests.keys().next().value!)
        }
        return
      case "print.request.resolved": {
        const practice = this.requests.get(e.requestId) ?? false
        this.requests.delete(e.requestId)
        return this.track("print_request", { approved: e.approved, practice })
      }
      case "print.finished":
        return this.track("print_finished", { state: e.state, practice: !!e.practice })
    }
  }

  /** Sends what's queued (at most BATCH events per request). Never throws. */
  async flush() {
    while (this.queue.length && this.consent === true && this.o.available) {
      const id = this.clientId()
      if (!id) return
      const events = this.queue.splice(0, BATCH)
      const body: GaPayload = {
        client_id: id,
        user_properties: { app_version: { value: VERSION.test(this.o.appVersion()) ? this.o.appVersion() : "unknown" }, os: { value: osName(platform()) }, arch: { value: archName(arch()) } },
        events,
      }
      try {
        await this.send(`${ENDPOINT}?measurement_id=${MEASUREMENT_ID}&api_secret=${encodeURIComponent(API_SECRET)}`, body)
      } catch {
        /* dropped: reports are best effort */
      }
    }
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.flush(), FLUSH_MS)
    this.timer.unref?.()
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.flush()
  }
}

// ---- The server's instance ----

let instance: Telemetry | null = null

/** Starts usage reports for this server (server/index.ts). Returns the stop function (flushes once more). */
export function startTelemetry(o: { studioHome: string; consent: boolean | null | undefined; appVersion: () => string; isPractice?: (machineId: string | undefined) => boolean; subscribe: (fn: (e: ServerEvent) => void) => () => void }) {
  const t = new Telemetry({ file: join(o.studioHome, "telemetry.json"), consent: o.consent, available: telemetryAvailable(), appVersion: o.appVersion, isPractice: o.isPractice })
  instance = t
  const off = o.subscribe((e) => {
    try {
      t.handle(e)
    } catch {
      /* never let reporting break the event bus */
    }
  })
  t.start()
  return async () => {
    off()
    await t.stop()
    if (instance === t) instance = null
  }
}

/** Events that don't come from the bus (routes). No-op before startTelemetry or without consent. */
export function track(name: TelemetryName, params: TelemetryParams = {}) {
  instance?.track(name, params)
}

/** Settings.telemetry changed (PUT /api/settings). */
export function setTelemetryConsent(v: boolean | null | undefined) {
  instance?.setConsent(v)
}
