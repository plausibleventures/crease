import { describe, expect, it } from "vitest"
import type { ServerEvent } from "../shared/types"
import { EventLog } from "./events"

const ev = (n: number): ServerEvent => ({ type: "jobs.changed", projectId: `p${n}` })
const seqs = (events: string[]) => events.map((j) => JSON.parse(j).eventSeq as number)

describe("EventLog (R08 replay / gap detection)", () => {
  it("numbers events 1,2,3… and puts eventSeq on the wire form", () => {
    const log = new EventLog(100, 1e9, "inst")
    expect(log.append(ev(1)).seq).toBe(1)
    const { seq, json } = log.append(ev(2))
    expect(seq).toBe(2)
    expect(JSON.parse(json)).toEqual({ type: "jobs.changed", projectId: "p2", eventSeq: 2 })
    expect(log.lastSeq).toBe(2)
  })

  it("first connect (no cursor) is fresh", () => {
    const log = new EventLog(100, 1e9, "inst")
    log.append(ev(1))
    const r = log.resume(null, null)
    expect(r.hello).toMatchObject({ type: "ws.hello", instanceId: "inst", eventSeq: 1, resume: "fresh", replayed: 0 })
    expect(r.events).toEqual([])
  })

  it("replays exactly the missed events, in order", () => {
    const log = new EventLog(100, 1e9, "inst")
    for (let i = 1; i <= 10; i++) log.append(ev(i))
    const r = log.resume(6, "inst")
    expect(r.hello.resume).toBe("replay")
    expect(r.hello.replayed).toBe(4)
    expect(seqs(r.events)).toEqual([7, 8, 9, 10])
  })

  it("up to date: replay with nothing to send", () => {
    const log = new EventLog(100, 1e9, "inst")
    for (let i = 1; i <= 3; i++) log.append(ev(i))
    expect(log.resume(3, "inst")).toMatchObject({ hello: { resume: "replay", replayed: 0 }, events: [] })
  })

  it("a gap that was evicted from the ring asks for a snapshot", () => {
    const log = new EventLog(5, 1e9, "inst")
    for (let i = 1; i <= 12; i++) log.append(ev(i))
    expect(log.oldestSeq).toBe(8)
    expect(log.resume(6, "inst").hello.resume).toBe("snapshot") // needs 7, evicted
    expect(seqs(log.resume(7, "inst").events)).toEqual([8, 9, 10, 11, 12]) // needs 8.., all buffered
  })

  it("evicts by bytes too (keeps at least the newest event)", () => {
    const one = JSON.stringify({ ...ev(1), eventSeq: 1 }).length
    const log = new EventLog(1000, one * 3, "inst")
    for (let i = 1; i <= 9; i++) log.append(ev(i))
    expect(log.lastSeq - log.oldestSeq + 1).toBeLessThanOrEqual(3)
    expect(log.resume(5, "inst").hello.resume).toBe("snapshot")
  })

  it("server restart (different instance) always means snapshot, even if the seq would fit", () => {
    const log = new EventLog(100, 1e9, "new")
    for (let i = 1; i <= 10; i++) log.append(ev(i))
    expect(log.resume(4, "old").hello).toMatchObject({ resume: "snapshot", instanceId: "new", eventSeq: 10 })
  })

  it("a cursor from the future (restarted server reusing the instance id is impossible, but be safe) -> snapshot", () => {
    const log = new EventLog(100, 1e9, "inst")
    log.append(ev(1))
    expect(log.resume(50, "inst").hello.resume).toBe("snapshot")
  })

  it("garbage cursors are treated as a first connect", () => {
    const log = new EventLog(100, 1e9, "inst")
    expect(log.resume(Number("x"), "inst").hello.resume).toBe("fresh")
    expect(log.resume(-1, "inst").hello.resume).toBe("fresh")
  })

  it("stays correct across ring compaction", () => {
    const log = new EventLog(10, 1e9, "inst")
    for (let i = 1; i <= 5000; i++) log.append(ev(i))
    expect(log.oldestSeq).toBe(4991)
    expect(seqs(log.resume(4995, "inst").events)).toEqual([4996, 4997, 4998, 4999, 5000])
  })
})
