import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import type { ServerEvent, WsHello } from "../shared/types"

/**
 * Sequenced event log: every emitted event gets the next `eventSeq` and is kept in a bounded ring (by count and by
 * serialized bytes) so a client that reconnects with its last seq can be replayed exactly what it missed. When the
 * gap has been evicted, the server restarted (different instanceId), or the cursor is nonsense, the client is told to
 * take a full snapshot instead.
 */
export class EventLog {
  readonly instanceId: string
  private seq = 0
  private ring: { seq: number; json: string }[] = []
  private head = 0 // index of the oldest entry in `ring` (ring is compacted lazily)
  private bytes = 0

  constructor(
    private readonly maxEvents = 10_000,
    private readonly maxBytes = 32 * 1024 * 1024,
    instanceId: string = randomUUID(),
  ) {
    this.instanceId = instanceId
  }

  get lastSeq() {
    return this.seq
  }

  /** Oldest seq still replayable (lastSeq + 1 when empty). */
  get oldestSeq() {
    return this.head < this.ring.length ? this.ring[this.head].seq : this.seq + 1
  }

  /** Assigns the next seq and stores the wire JSON. */
  append(event: ServerEvent): { seq: number; json: string } {
    const seq = ++this.seq
    const json = JSON.stringify({ ...event, eventSeq: seq })
    this.ring.push({ seq, json })
    this.bytes += json.length
    while (this.ring.length - this.head > this.maxEvents || (this.bytes > this.maxBytes && this.ring.length - this.head > 1)) {
      this.bytes -= this.ring[this.head].json.length
      this.head++
    }
    if (this.head > 1024 && this.head * 2 > this.ring.length) {
      this.ring = this.ring.slice(this.head)
      this.head = 0
    }
    return { seq, json }
  }

  /**
   * What a (re)connecting client gets. `since` = the last eventSeq it applied, `instance` = the instanceId it had.
   * replay: `events` (wire JSON, seq > since, in order) are exactly the missed ones.
   */
  resume(since: number | null, instance: string | null): { hello: WsHello; events: string[] } {
    const hello = (resume: WsHello["resume"], events: string[]) => ({
      hello: { type: "ws.hello" as const, instanceId: this.instanceId, eventSeq: this.seq, resume, replayed: events.length },
      events,
    })
    if (since == null || !Number.isInteger(since) || since < 0) return hello("fresh", [])
    if (instance !== this.instanceId || since > this.seq) return hello("snapshot", [])
    if (since === this.seq) return hello("replay", [])
    if (since + 1 < this.oldestSeq) return hello("snapshot", []) // part of the gap was evicted
    const out: string[] = []
    for (let i = this.head; i < this.ring.length; i++) if (this.ring[i].seq > since) out.push(this.ring[i].json)
    return hello("replay", out)
  }
}

// Process-wide event bus. Every ServerEvent emitted here is sequenced and broadcast to all WS clients.
const bus = new EventEmitter()
bus.setMaxListeners(100)
export const eventLog = new EventLog()

export function emit(event: ServerEvent) {
  const { json } = eventLog.append(event)
  bus.emit("event", event, json)
}

/** Live events; `json` is the wire form (with eventSeq). */
export function onEvent(fn: (e: ServerEvent, json: string) => void): () => void {
  bus.on("event", fn)
  return () => bus.off("event", fn)
}
