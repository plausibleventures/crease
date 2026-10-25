// Printer cameras. Creality firmware (K1/K2/SPARKX i7) has no Moonraker webcam / mjpg; it serves WebRTC on :8000:
// GET / is a demo page whose JS creates an offer (one video transceiver, non-trickle ICE: it waits for gathering
// to finish), then POSTs base64(JSON {type:"offer", sdp}) to /call/webrtc_local with Content-Type "plain/text"
// and gets base64(JSON {type:"answer", sdp}) back. We proxy only that exchange; media flows printer → app on the LAN.
import { randomUUID } from "node:crypto"
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os"
import type { Machine, MachineCamera } from "../../shared/types"
import { emit } from "../events"

const httpErr = (statusCode: number, msg: string) => Object.assign(new Error(msg), { statusCode })

async function get(url: string, ms = 3000): Promise<{ ok: boolean; type: string; text: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
    const type = r.headers.get("content-type") ?? ""
    return { ok: r.ok, type, text: type.startsWith("image/") ? "" : (await r.text()).slice(0, 20_000) }
  } catch {
    return { ok: false, type: "", text: "" }
  }
}

/** Find how this printer's camera can be watched (read-only GETs). */
export async function detectCamera(m: Machine, moonrakerWebcams: { snapshotUrl: string | null; streamUrl: string | null }[]): Promise<MachineCamera> {
  const at = new Date().toISOString()
  if (moonrakerWebcams.some((w) => w.snapshotUrl || w.streamUrl)) return { type: "moonraker", detectedAt: at }
  if (m.isPractice || m.connection.type !== "moonraker") return { type: "none", detectedAt: at }
  const host = m.connection.host
  const page = await get(`http://${host}:8000/`)
  if (page.ok && /webrtc_local/.test(page.text)) return { type: "creality-webrtc", url: `http://${host}:8000`, detectedAt: at }
  const mj = await get(`http://${host}:8080/?action=snapshot`)
  if (mj.ok && mj.type.startsWith("image/")) return { type: "mjpeg", url: `http://${host}:8080/?action=stream`, detectedAt: at }
  return { type: "none", detectedAt: at }
}

// ---------- local-only ICE: real host candidates instead of mDNS names ----------

const MDNS_RE = /^[0-9a-f-]{8,}\.local$/i

/**
 * Replace Chromium's mDNS host-candidate names ("<uuid>.local", which printers can't resolve) with this computer's
 * LAN address, so ICE works without a STUN server. Touches only `a=candidate` address fields and `c=` lines; every
 * other line is kept byte for byte. Returns the SDP and how many candidates were rewritten.
 */
export function rewriteMdnsCandidates(sdp: string, localIp: string | null): { sdp: string; rewritten: number } {
  if (!localIp) return { sdp, rewritten: 0 }
  let rewritten = 0
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n"
  const lines = sdp.split(/\r?\n/).map((line) => {
    if (line.startsWith("a=candidate:")) {
      // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
      const f = line.split(" ")
      if (f.length > 7 && MDNS_RE.test(f[4])) {
        f[4] = localIp
        rewritten++
        return f.join(" ")
      }
      return line
    }
    const c = line.match(/^c=IN IP4 (\S+)$/)
    if (c && MDNS_RE.test(c[1])) return `c=IN IP4 ${localIp}`
    return line
  })
  return { sdp: lines.join(eol), rewritten }
}

const ip4 = (s: string) => s.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0

/** This computer's IPv4 address on the printer's network (same subnet), else its first non-internal IPv4. */
export function localAddressFor(printerHost: string, ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string | null {
  const all = Object.values(ifaces)
    .flat()
    .filter((i): i is NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(printerHost)) {
    const same = all.find((i) => (ip4(i.address) & ip4(i.netmask)) === (ip4(printerHost) & ip4(i.netmask)))
    if (same) return same.address
  }
  return all[0]?.address ?? null
}

/** The offer as the printer should see it: mDNS host names swapped for our LAN address (nothing else changes). */
function localOffer(m: Machine, sdp: string): string {
  if (m.connection.type !== "moonraker" || !/\.local[\s\r\n]/i.test(sdp)) return sdp
  return rewriteMdnsCandidates(sdp, localAddressFor(m.connection.host)).sdp
}

/** Relay a browser's SDP offer to the printer's Creality WebRTC endpoint and return its answer. */
export async function crealityWebrtcAnswer(m: Machine, offer: { type: string; sdp: string }): Promise<{ type: "answer"; sdp: string }> {
  if (m.camera?.type !== "creality-webrtc" || !m.camera.url) throw httpErr(409, `${m.name} has no WebRTC camera`)
  if (offer?.type !== "offer" || typeof offer.sdp !== "string" || offer.sdp.length > 100_000) throw httpErr(400, "body must be {offer: {type: 'offer', sdp}}")
  let text: string
  try {
    const r = await fetch(`${m.camera.url}/call/webrtc_local`, {
      method: "POST",
      headers: { "Content-Type": "plain/text" },
      body: Buffer.from(JSON.stringify({ type: "offer", sdp: localOffer(m, offer.sdp) })).toString("base64"),
      signal: AbortSignal.timeout(8000),
    })
    text = await r.text()
    if (!r.ok) throw httpErr(502, `camera answered ${r.status}`)
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode) throw e
    throw httpErr(502, `couldn't reach ${m.name}'s camera: ${(e as Error).message}`)
  }
  let ans: { type?: string; sdp?: string }
  try {
    ans = JSON.parse(Buffer.from(text.trim(), "base64").toString("utf8"))
  } catch {
    throw httpErr(502, "camera sent an answer we couldn't read")
  }
  if (ans.type !== "answer" || !ans.sdp) throw httpErr(502, "camera didn't answer the offer")
  return { type: "answer", sdp: ans.sdp }
}

// ---------- frames from the app (WebRTC can't be decoded server-side without a media stack) ----------

const waiting = new Map<string, { resolve: (v: { data: Buffer; contentType: string }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

/** Ask an open app window for one frame of this machine's camera (JPEG). Times out if no window answers. */
export function captureFromApp(machineId: string, timeoutMs = 12_000): Promise<{ data: Buffer; contentType: string }> {
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId)
      reject(httpErr(504, "The camera needs the Crease app open to take a picture (it streams over WebRTC to the app)."))
    }, timeoutMs)
    timer.unref()
    waiting.set(requestId, { resolve, reject, timer })
    emit({ type: "camera.capture.request", requestId, machineId })
  })
}

/** The app's reply to a capture request: a data: URL (image/jpeg|png) or an error. First reply wins. */
export function deliverCapture(requestId: string, body: { dataUrl?: string; error?: string }) {
  const w = waiting.get(requestId)
  if (!w) return false
  waiting.delete(requestId)
  clearTimeout(w.timer)
  const m = body.dataUrl?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/)
  if (m) w.resolve({ contentType: m[1], data: Buffer.from(m[2], "base64") })
  else w.reject(httpErr(502, body.error || "the app couldn't capture a frame"))
  return true
}
