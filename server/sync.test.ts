// R08 end to end over a real socket: hello/replay on reconnect, snapshot contents, and a question answered while the
// client was disconnected. Temp PRINTSTUDIO_HOME: no machines besides what the test makes (never a real printer).
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import WebSocket from "ws"
import type { SyncSnapshot } from "../shared/types"

process.env.PRINTSTUDIO_HOME = mkdtempSync(join(tmpdir(), "printstudio-sync-test-"))
const { startServer } = await import("./index")
const { emit, eventLog } = await import("./events")
const { askUser, answerQuestion } = await import("./agent/questions")

let base = ""
let close: () => Promise<void> = async () => {}
let inject: (o: { method: "GET" | "POST"; url: string; headers?: Record<string, string> }) => Promise<{ statusCode: number }>

beforeAll(async () => {
  const { app, address } = await startServer({ port: 0, host: "127.0.0.1" })
  base = address.replace(/^http/, "ws")
  close = () => app.close()
  inject = (o) => app.inject(o)
})
afterAll(() => close())

type Frame = { type: string; eventSeq?: number; resume?: string; [k: string]: unknown }

/** Connect, collect frames; resolves once `count` non-ping frames arrived. */
function connect(query = "") {
  const ws = new WebSocket(`${base}/ws${query ? `?${query}` : ""}`)
  const frames: Frame[] = []
  const waiters: { n: number; resolve: () => void }[] = []
  ws.on("message", (d) => {
    const f = JSON.parse(String(d)) as Frame
    if (f.type === "ws.ping") return
    frames.push(f)
    for (const w of [...waiters]) {
      if (frames.length < w.n) continue
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve()
    }
  })
  return {
    ws,
    frames,
    /** Resolves once a frame of this type arrived (other events, e.g. printer polling, may interleave). */
    untilType: async (type: string) => {
      while (!frames.some((f) => f.type === type)) await new Promise((r) => setTimeout(r, 10))
    },
    until: (n: number) => (frames.length >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve }))),
    close: () => new Promise<void>((r) => (ws.once("close", () => r()), ws.close())),
  }
}

describe("WS resume over a real socket", () => {
  it("first connect is fresh; live events carry consecutive eventSeq", async () => {
    const c = connect()
    await c.until(1)
    expect(c.frames[0]).toMatchObject({ type: "ws.hello", instanceId: eventLog.instanceId, resume: "fresh" })
    emit({ type: "jobs.changed", projectId: "a" })
    emit({ type: "jobs.changed", projectId: "b" })
    await c.until(3)
    expect(c.frames[2].eventSeq).toBe((c.frames[1].eventSeq as number) + 1)
    await c.close()
  })

  it("question asked, client drops, question answered elsewhere: reconnect replays both; snapshot has none pending", async () => {
    const c = connect()
    await c.until(1)
    const ctl = new AbortController()
    const parked = askUser("p1", "s1", { questions: [{ question: "Size?", header: "Size", options: [{ label: "S" }, { label: "L" }] }] }, {
      signal: ctl.signal,
      toolUseID: "tu-1",
    })
    await c.untilType("agent.question")
    const last = c.frames.find((f) => f.type === "agent.question")!.eventSeq as number
    await c.close()

    // while disconnected
    let snap = (await (await fetch(`${base.replace(/^ws/, "http")}/api/sync/snapshot`)).json()) as SyncSnapshot
    expect(snap.questions.map((q) => q.requestId)).toEqual(["tu-1"])
    answerQuestion("p1", "tu-1", { "Size?": "L" })
    await parked
    emit({ type: "print.request.resolved", requestId: "r-x", approved: false })

    const r = connect(`since=${last}&instance=${eventLog.instanceId}`)
    await r.untilType("print.request.resolved")
    expect(r.frames[0]).toMatchObject({ type: "ws.hello", resume: "replay" })
    // Replayed in order, numbered after the cursor; unrelated events (printer polling) may sit in between.
    const seqs = r.frames.slice(1).map((f) => f.eventSeq as number)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqs[0]).toBe(last + 1)
    const ours = r.frames.filter((f) => f.type === "agent.question.resolved" || f.type === "print.request.resolved").map((f) => f.type)
    expect(ours).toEqual(["agent.question.resolved", "print.request.resolved"])
    await r.close()

    snap = (await (await fetch(`${base.replace(/^ws/, "http")}/api/sync/snapshot`)).json()) as SyncSnapshot
    expect(snap).toMatchObject({ instanceId: eventLog.instanceId, eventSeq: eventLog.lastSeq, questions: [], printRequests: [] })
  })

  it("a cursor from another server instance gets a snapshot hello and no replay", async () => {
    emit({ type: "jobs.changed", projectId: "z" })
    const c = connect(`since=1&instance=not-this-server`)
    await c.until(1)
    await new Promise((r) => setTimeout(r, 50))
    expect(c.frames).toHaveLength(1)
    expect(c.frames[0]).toMatchObject({ type: "ws.hello", resume: "snapshot", replayed: 0 })
    await c.close()
  })

  it("snapshot for a missing project reports the error and still returns the global state", async () => {
    const snap = (await (await fetch(`${base.replace(/^ws/, "http")}/api/sync/snapshot?projectId=nope`)).json()) as SyncSnapshot
    expect(snap.project).toBeNull()
    expect(typeof snap.projectError).toBe("string")
    expect(Array.isArray(snap.machines)).toBe(true)
  })

  it("a print that finished while the window was away comes back unrated in the snapshot until it's rated", async () => {
    const db = await import("./db/index")
    const rec = db.recordPrintStart({ projectId: "nope", partIds: ["main"], gcodeName: "main.gcode", printerFilename: null, estimatedTimeS: 60, filamentG: 1 })
    db.recordPrintFinish(rec.id, "complete")
    const snapshot = async () => (await (await fetch(`${base.replace(/^ws/, "http")}/api/sync/snapshot`)).json()) as SyncSnapshot
    expect((await snapshot()).unratedPrints).toContainEqual(expect.objectContaining({ printId: rec.id, projectId: "nope", state: "complete" }))
    db.setPrintResult(rec.id, { result: "success" })
    expect((await snapshot()).unratedPrints?.some((p) => p.printId === rec.id)).toBe(false)
  })

  it("unratedPrints: finished, unrated, last 48 h, newest first, at most 5", async () => {
    const { unratedPrints } = await import("./sync")
    const now = Date.parse("2026-10-09T12:00:00Z")
    const p = (id: string, hoursAgo: number | null, over: object = {}) =>
      ({ id, projectId: "p", partIds: [], gcodeName: "g", printerFilename: null, startedAt: "2026-10-01T00:00:00Z", finishedAt: hoursAgo === null ? null : new Date(now - hoursAgo * 3600_000).toISOString(), state: hoursAgo === null ? "printing" : "complete", result: null, notes: null, estimatedTimeS: null, filamentG: null, ...over }) as import("../shared/types").PrintRecord
    const list = [p("running", null), p("old", 49), p("rated", 1, { result: "success" }), p("a", 3), p("b", 1), p("cancelled", 2, { state: "cancelled" })]
    expect(unratedPrints(list, now).map((x) => x.printId)).toEqual(["b", "cancelled", "a"])
    expect(unratedPrints(Array.from({ length: 8 }, (_, i) => p(`x${i}`, i)), now)).toHaveLength(5)
  })
})

describe("dev mode (no token): loopback origins only", () => {
  const post = (headers: Record<string, string>) => inject({ method: "POST", url: "/api/printer/pause", headers }).then((r) => r.statusCode)
  it("refuses cross-site browser requests and DNS-rebinding hosts before any handler runs", async () => {
    expect(await post({ host: "127.0.0.1:5174", origin: "https://evil.example" })).toBe(403)
    expect(await post({ host: "127.0.0.1:5174", origin: "null" })).toBe(403)
    expect(await post({ host: "127.0.0.1:5174", "sec-fetch-site": "cross-site" })).toBe(403)
    expect(await post({ host: "evil.example:5174" })).toBe(403)
    const ws = await inject({ method: "GET", url: "/ws", headers: { host: "127.0.0.1:5174", origin: "http://evil.example" } })
    expect(ws.statusCode).toBe(403)
  })
  it("lets the dev UI (vite on localhost) and non-browser clients through", async () => {
    const ok = (r: { statusCode: number }) => r.statusCode !== 403
    expect(ok(await inject({ method: "GET", url: "/api/health", headers: { host: "localhost:5173", origin: "http://localhost:5173" } }))).toBe(true)
    expect(ok(await inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1:5174" } }))).toBe(true)
    expect(ok(await inject({ method: "GET", url: "/api/health", headers: { host: "[::1]:5174", origin: "http://[::1]:5173" } }))).toBe(true)
  })
})
