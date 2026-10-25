// Printer cameras in the renderer. Creality printers stream H.264 over WebRTC; the server only relays the SDP
// offer/answer (POST /api/machines/:id/camera/webrtc), media flows straight from the printer on the LAN.
import { api } from "@/lib/api"
import { icePlan } from "@shared/camera-ice"

/**
 * Open a camera session following the machine's ICE plan (shared/camera-ice.ts): LAN printers first try host
 * candidates only (no STUN: nothing leaves the network); if no video arrives within a few seconds and the plan has a
 * fallback, retry once through the STUN server. `via` says which one worked.
 */
export async function connectCamera(
  machine: { id: string; connection: Parameters<typeof icePlan>[0] },
  onStream: (s: MediaStream) => void,
): Promise<{ pc: RTCPeerConnection; via: "local" | "stun"; label: string }> {
  const plan = icePlan(machine.connection)
  const first = await connectWebrtc(machine.id, onStream, plan.first)
  const firstVia = plan.first.length ? "stun" : "local"
  if (!plan.fallback || (await receivesVideo(first, NO_VIDEO_MS))) return { pc: first, via: firstVia, label: plan.label }
  first.close()
  const pc = await connectWebrtc(machine.id, onStream, plan.fallback)
  return { pc, via: "stun", label: "local-only didn't get a picture; using the STUN server" }
}

const NO_VIDEO_MS = 6000

/** True once the session has received video bytes (polls getStats), false after `ms`. */
export async function receivesVideo(pc: RTCPeerConnection, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") return false
    try {
      const stats = await pc.getStats()
      let bytes = 0
      stats.forEach((r) => {
        if (r.type === "inbound-rtp" && (r as { kind?: string }).kind === "video") bytes += (r as { bytesReceived?: number }).bytesReceived ?? 0
      })
      if (bytes > 0) return true
    } catch {
      /* closed meanwhile */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/**
 * Open a receive-only WebRTC session to a machine's camera with the given ICE servers ([] = host candidates only).
 * Non-trickle ICE (the printer wants every candidate in the offer). Host-only works because the Electron app shows
 * real LAN addresses (mDNS hiding off) and the server swaps any mDNS names for this computer's LAN address.
 */
export async function connectWebrtc(machineId: string, onStream: (s: MediaStream) => void, iceServers: RTCIceServer[] = []): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection({ iceServers })
  pc.addTransceiver("video", { direction: "recvonly" })
  pc.ontrack = (e) => onStream(e.streams[0] ?? new MediaStream([e.track]))
  try {
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve()
      const done = () => pc.iceGatheringState === "complete" && resolve()
      pc.addEventListener("icegatheringstatechange", done)
      setTimeout(resolve, 3000) // don't wait forever for slow STUN
    })
    const answer = await api.cameraWebrtc(machineId, { type: "offer", sdp: pc.localDescription!.sdp })
    await pc.setRemoteDescription(answer)
    return pc
  } catch (e) {
    pc.close()
    throw e
  }
}

// Live <video> elements per machine, so a capture can reuse a stream that's already open.
const live = new Map<string, HTMLVideoElement>()
export function registerVideo(machineId: string, v: HTMLVideoElement) {
  live.set(machineId, v)
  return () => {
    if (live.get(machineId) === v) live.delete(machineId)
  }
}

function frameToJpeg(v: HTMLVideoElement): string {
  const c = document.createElement("canvas")
  c.width = v.videoWidth
  c.height = v.videoHeight
  c.getContext("2d")!.drawImage(v, 0, 0)
  return c.toDataURL("image/jpeg", 0.85)
}

/** One JPEG frame (data URL) from a machine's WebRTC camera: from an open view, or a short-lived session. */
export async function captureFrame(machine: { id: string; connection: Parameters<typeof icePlan>[0] }): Promise<string> {
  const machineId = machine.id
  const open = live.get(machineId)
  if (open && open.videoWidth > 0) return frameToJpeg(open)
  const v = document.createElement("video")
  v.muted = true
  v.playsInline = true
  let pc: RTCPeerConnection | null = null
  try {
    pc = (
      await connectCamera(machine, (s) => {
        v.srcObject = s
        void v.play().catch(() => {})
      })
    ).pc
    for (let i = 0; i < 60 && !(v.videoWidth > 0 && v.readyState >= 2); i++) await new Promise((r) => setTimeout(r, 150))
    if (!(v.videoWidth > 0)) throw new Error("the camera sent no picture")
    await new Promise((r) => setTimeout(r, 400)) // let a full frame decode
    return frameToJpeg(v)
  } finally {
    pc?.close()
    v.srcObject = null
  }
}
