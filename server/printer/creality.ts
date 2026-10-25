// Creality firmware's own websocket API (ws://<printer>:9999). Listen-only: we never send anything; the printer
// pushes JSON objects with partial updates (deviceState, state, layer, TotalLayer, printLeftTime, printJobTime,
// printProgress, printFileName, nozzleTemp, ...). On the SPARKX i7 (fw 1.1.5.x) Klipper's print_stats stays frozen
// at "standby" during a print, so this is the best source for layer and time left.
import type { Machine } from "../../shared/types"

export interface CrealityState {
  deviceState?: number // 1 = printing (only code confirmed on the i7)
  state?: number
  layer?: number
  TotalLayer?: number
  printLeftTime?: number // s
  printJobTime?: number // s
  printProgress?: number // 0..100
  printFileName?: string
  err?: { errcode?: number; key?: number; value?: string }
  [k: string]: unknown
}

interface Conn {
  url: string
  ws: WebSocket | null
  data: CrealityState
  at: number // last message (ms)
  retryAt: number // next connect attempt (ms)
  failures: number
}
const conns = new Map<string, Conn>()

function wsUrl(m: Machine): string | null {
  if (m.isPractice || m.connection.type !== "moonraker" || !m.connection.host) return null
  const port = m.connection.crealityWsPort ?? 9999
  return port ? `ws://${m.connection.host}:${port}` : null
}

function open(id: string, c: Conn) {
  try {
    const ws = new WebSocket(c.url)
    c.ws = ws
    ws.onmessage = (e) => {
      try {
        const j = JSON.parse(String(e.data))
        if (j && typeof j === "object") {
          Object.assign(c.data, j)
          c.at = Date.now()
          c.failures = 0
        }
      } catch {
        /* non-JSON frame */
      }
    }
    const lost = () => {
      if (c.ws !== ws) return
      c.ws = null
      c.failures++
      // Back off: 5 s, 10 s, ... up to 2 min (most printers don't have this API at all).
      c.retryAt = Date.now() + Math.min(120_000, 5000 * c.failures)
    }
    ws.onclose = lost
    ws.onerror = lost
  } catch {
    c.failures++
    c.retryAt = Date.now() + Math.min(120_000, 5000 * c.failures)
  }
  void id
}

/** Keep a listen-only connection per machine (call each poll). Returns fresh data, or null if none/stale. */
export function crealityState(m: Machine): CrealityState | null {
  const url = wsUrl(m)
  let c = conns.get(m.id)
  if (c && c.url !== url) {
    c.ws?.close()
    conns.delete(m.id)
    c = undefined
  }
  if (!url) return null
  if (!c) {
    c = { url, ws: null, data: {}, at: 0, retryAt: 0, failures: 0 }
    conns.set(m.id, c)
  }
  if (!c.ws && Date.now() >= c.retryAt) open(m.id, c)
  return c.at && Date.now() - c.at < 15_000 ? c.data : null
}

// ---------- Starting a job through Creality's own service (experimental, per-machine opt-in) ----------
//
// Jobs started with Moonraker's /printer/print/start run fine on the i7, but the touchscreen and Creality's job
// tracking don't know about them (deviceState stays 1 until dismissed on the screen; no history entry). Creality
// Print / OrcaSlicer's "crealityprint" host type start jobs over :9999 instead. From OrcaSlicer
// src/slic3r/Utils/CrealityPrint.cpp and community K1/K2 API notes (github.com/Erinell/Creality-K2-websocket);
// NOT yet run on real hardware — docs/printer-bringup.md "Supervised test: Creality start".
//   single colour / spool holder: {"method":"set","params":{"opGcodeFile":"printprt:<full path>","enableSelfTest":0}}
//   CFS: {"method":"set","params":{"colorMatch":{"path":"<full path>","list":[{id:"T1A",type,color,boxId,materialId}]}}}
//        then {"method":"set","params":{"multiColorPrint":{"gcode":"<full path>","enableSelfTest":0}}}
// K1 firmware closes the socket right after accepting a start; that's not an error.

export interface CrealitySlot {
  slot: number // 1-based machine slot (T1 A–D = 1–4, T2 A–D = 5–8 …)
  material: string
  colorHex: string
}

/** CFS slot id as Creality names it: slot 1 → "T1A", 6 → "T2B". */
export const crealitySlotId = (slot: number) => `T${Math.floor((slot - 1) / 4) + 1}${"ABCD"[(slot - 1) % 4]}`

/**
 * The :9999 messages that start `fullPath` (the file's absolute path on the printer). `slots` = the slots the file
 * uses, in G-code filament order (T0 = first); when given (CFS print) the colour mapping is sent first.
 */
export function crealityStartMessages(fullPath: string, slots: CrealitySlot[] | null): object[] {
  if (!slots?.length) return [{ method: "set", params: { opGcodeFile: `printprt:${fullPath}`, enableSelfTest: 0 } }]
  const list = slots.map((s) => ({
    id: crealitySlotId(s.slot),
    type: s.material,
    color: s.colorHex.toLowerCase(),
    boxId: Math.floor((s.slot - 1) / 4) + 1,
    // Unverified: findings.md's example has materialId 0 for the first filament; we send the G-code filament index.
    materialId: s.slot - 1,
  }))
  return [
    { method: "set", params: { colorMatch: { path: fullPath, list } } },
    { method: "set", params: { multiColorPrint: { gcode: fullPath, enableSelfTest: 0 } } },
  ]
}

export class CrealityStartError extends Error {
  constructor(
    message: string,
    /** true = nothing reached the printer (safe to start another way) */
    public notSent: boolean,
  ) {
    super(message)
  }
}

/** Send the start messages over a fresh :9999 connection. Resolves once they were sent (replies are only logged). */
export async function startViaCreality(m: Machine, fullPath: string, slots: CrealitySlot[] | null, opts: { connectMs?: number; settleMs?: number } = {}): Promise<{ replies: unknown[] }> {
  const url = m.connection.type === "moonraker" && m.connection.host ? `ws://${m.connection.host}:${m.connection.crealityWsPort || 9999}` : null
  if (!url) throw new CrealityStartError(`${m.name} has no Creality service address`, true)
  const messages = crealityStartMessages(fullPath, slots)
  return new Promise((resolve, reject) => {
    const replies: unknown[] = []
    let sent = 0
    let settled = false
    let ws: WebSocket
    const done = (err?: CrealityStartError) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      try {
        ws.close()
      } catch {
        /* closed */
      }
      if (err) reject(err)
      else resolve({ replies })
    }
    try {
      ws = new WebSocket(url)
    } catch (e) {
      reject(new CrealityStartError(`couldn't open ${url}: ${(e as Error).message}`, true))
      return
    }
    const connectTimer = setTimeout(() => done(new CrealityStartError(`no answer from ${url}`, true)), opts.connectMs ?? 5000)
    ws.onmessage = (e) => {
      try {
        const j = JSON.parse(String(e.data))
        // the printer also pushes status; keep only what looks like a reply to "set"
        if (j && typeof j === "object" && ("ret" in j || "result" in j || "error" in j || "colorMatch" in j || "multiColorPrint" in j || "opGcodeFile" in j)) replies.push(j)
      } catch {
        /* non-JSON */
      }
    }
    ws.onopen = async () => {
      clearTimeout(connectTimer)
      for (const msg of messages) {
        if (ws.readyState !== WebSocket.OPEN) break
        ws.send(JSON.stringify(msg))
        sent++
        await new Promise((r) => setTimeout(r, 400)) // let the firmware take colorMatch before the start
      }
      if (sent < messages.length) return done(new CrealityStartError(`the printer closed the connection after ${sent} of ${messages.length} messages`, sent === 0))
      setTimeout(() => done(), opts.settleMs ?? 1000)
    }
    ws.onclose = () => {
      // K1 firmware closes right after accepting a start: fine once everything was sent.
      if (sent >= messages.length) done()
      else if (sent === 0) done(new CrealityStartError(`${url} closed before anything was sent`, true))
    }
    ws.onerror = () => {
      if (sent === 0) done(new CrealityStartError(`couldn't connect to ${url}`, true))
    }
  })
}

/** Drop connections for machines that are gone or no longer polled. */
export function pruneCreality(keep: Set<string>) {
  for (const [id, c] of conns) {
    if (!keep.has(id)) {
      c.ws?.close()
      conns.delete(id)
    }
  }
}
