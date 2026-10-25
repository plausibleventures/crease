// ICE (network path) settings for WebRTC printer cameras (Creality :8000). Pure; used by the renderer
// (src/lib/camera.ts) and the server (machines.ts sanitising, camera.ts SDP handling).
//
// Before R19 every session used Google's public STUN server: with only host candidates the i7 reached ICE
// "connected" but never sent video, because Chromium hides the LAN address behind an mDNS name the printer can't
// resolve. Now LAN printers default to no STUN at all: Electron shows real host candidates
// (WebRtcHideLocalIpsWithMdns off) and the server swaps any remaining mDNS names for this computer's LAN address.
import type { CameraIce } from "./types"

export const DEFAULT_STUN = ["stun:stun.l.google.com:19302"]

/** Private / link-local / loopback IPs and mDNS hostnames: a printer on the local network. */
export function isLanHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (!h) return false
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (h.includes(":")) return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
  return !h.includes(".") // a bare hostname ("sparks") resolves on the LAN
}

const STUN_RE = /^(stun|turn)s?:[^\s]+$/i

/** Clean a CameraIce from user input / machines.json; null = default ("auto", no custom list). */
export function normCameraIce(v: unknown): CameraIce | null {
  if (!v || typeof v !== "object") return null
  const o = v as { mode?: unknown; stunServers?: unknown }
  const mode = o.mode === "local" || o.mode === "custom" || o.mode === "auto" ? o.mode : "auto"
  const list = Array.isArray(o.stunServers) ? o.stunServers.map((s) => String(s).trim()).filter((s) => STUN_RE.test(s)).slice(0, 8) : []
  if (mode === "auto" && !list.length) return null
  return { mode, ...(list.length ? { stunServers: list } : {}) }
}

export interface IcePlan {
  /** iceServers for the first attempt ([] = host candidates only, nothing leaves the LAN) */
  first: { urls: string[] }[]
  /** iceServers to retry with if the first attempt gets no picture (null = don't retry) */
  fallback: { urls: string[] }[] | null
  /** plain words for the camera view */
  label: string
}

/** How to connect to a machine's camera. */
export function icePlan(connection: { type: string; host?: string; cameraIce?: CameraIce }): IcePlan {
  const ice = normCameraIce(connection.cameraIce) ?? { mode: "auto" as const }
  const stun = ice.stunServers?.length ? ice.stunServers : DEFAULT_STUN
  const servers = [{ urls: stun }]
  if (ice.mode === "local") return { first: [], fallback: null, label: "local network only" }
  if (ice.mode === "custom") return { first: servers, fallback: null, label: `via ${stun.join(", ")}` }
  const lan = connection.type === "moonraker" && !!connection.host && isLanHost(connection.host)
  return lan
    ? { first: [], fallback: servers, label: "local network (STUN only if that fails)" }
    : { first: servers, fallback: null, label: `via ${stun.join(", ")}` }
}
